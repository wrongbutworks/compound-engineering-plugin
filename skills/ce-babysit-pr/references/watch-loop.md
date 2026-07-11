# Watch loop — scheduling, state, dedup, edge cases

Read this once per babysit session, before acting on the first tick's output. It defines *how ticks are scheduled per harness*, the *on-disk state contract*, the *claim→act→confirm dedup protocol* that makes ticks idempotent and crash-safe, and the *edge-case handling*. SKILL.md owns the ordering invariant; this file owns the mechanics.

## Why there are two execution modes

A skill cannot assume it can schedule its own next invocation. No harness offers a portable "run me again in N minutes" primitive, and the naive substitutes fail:

- Foreground `sleep` — **blocked on Claude Code** (and ties up the session everywhere else).
- "The agent just continues after a delay" — nothing actually wakes the next tick; it is either a busy-spin or a single shot.
- Detached background processes — not reliably available in GUI app harnesses, which sandbox the turn.

So the honest contract is capability-gated:

| Harness | Verified self-scheduling primitive | Default mode |
|---------|------------------------------------|--------------|
| Claude Code (CLI) | `ScheduleWakeup`, or the `/loop` skill | Continuous (offer) |
| Grok (CLI / interactive TUI) | `scheduler_create` (agent tool; `durable:true` persists across sessions, 60s min, recurring auto-expires 7d) or `/loop` — each fire is a fresh agent turn | Continuous (offer) |
| Codex (CLI) | Background paced process, only if the sandbox permits | Checkpoint unless verified |
| Cursor (CLI) | `/loop` exists but is a best-effort background-shell wake tied to the session, **not** a scheduler API | **Checkpoint** (continuous only if `/loop` is verified live) |
| GUI app harnesses (Claude Code app, Codex App, **Cursor Desktop Agent**) | None reliable — no cross-session wakeup; background work dies with the session | **Checkpoint** |
| Grok headless (`grok -p`) | one-shot; exits after the response | **Checkpoint** |
| Any other / unknown | None assumed | **Checkpoint** |

Cross-harness facts (verified with the harnesses): a **foreground `sleep` loop is blocked or discouraged everywhere** (Claude Code blocks it; Grok and Cursor discourage it and cap shell calls) — never the mechanism. A **detached `nohup` process that outlives the session is unreliable/unsupported** on Grok and Cursor — do not rely on it. Only Claude Code (`ScheduleWakeup`) and Grok (`scheduler_create --durable`) offer **cross-session** wakeup. `/tmp` **does** persist across ticks on one machine, but **shell environment variables do not persist between separate tool calls** on any harness — every command that uses `SKILL_DIR`/`STATE_DIR` must re-set them inline (this is why checkpoint's disk-resumable state is the portable spine).

**Continuous mode:** drive the verified primitive; each wake re-enters SKILL.md Step 2. **Checkpoint mode:** run one tick, persist, report status, and print the exact re-run command (e.g. `/ce-babysit-pr <PR-url>`). Monitoring is paused between ticks — state that plainly so the user is never misled into thinking a frozen session is "watching."

Because every tick is resumable from disk, checkpoint mode is not degraded correctness — it is the same loop, hand-cranked. Continuous mode only automates the crank.

## Cadence (continuous mode)

- **Active** (checks in progress, or activity in the last tick): ~2-3 min. Faster than this rate-limits the API and re-triggers the heavy `ce-resolve-pr-feedback` pass for no benefit.
- **Quiet** (no failing checks, no new threads): ~5-10 min.
- Reset to active after any push, new comment, or check transition.
- Honor GitHub rate-limit reset headers; back off on `403`/`429`.
- After any mutation, re-snapshot at the *start of the next tick*, not mid-tick.

## Pipeline mode bound (`mode:pipeline`)

An orchestrator (`lfg`) drives ticks in-line and needs the loop to terminate. Run ticks back-to-back until the stop below. **To wait for CI to progress between ticks, use the harness's native non-blocking wait — never a bare foreground `sleep`** (blocked on Claude Code, discouraged elsewhere): Claude Code's `Monitor` until-loop; Grok's `get_command_or_subagent_output(timeout_ms=…)` or a `monitor`; Cursor's `Await` on a backgrounded `gh pr checks --watch`. If the harness has no non-blocking wait, do one tick and return control to the orchestrator rather than busy-spinning. Loop until:

- **all checks are terminal** (each `COMPLETED`/errored, none `IN_PROGRESS` or `QUEUED`) **and** the actionable backlog is empty — success; or
- a **budget** is hit: default **3 CI fix rounds** per head-lineage (mirrors `lfg`'s historical cap) and an overall time cap (~30-45 min). On budget-exhaust, the still-red checks and any `needs-human` items become residuals.

Never wait on the merge-ready settle window or human review in pipeline mode — those are interactive stops. A check stuck `IN_PROGRESS` past the time cap ends the run with a "CI still running" residual rather than blocking forever.

The round/time budget above is a **blunt cost floor**, not a convergence detector — it catches a runaway that never trips the trajectory-driven stop below. Prefer to stop *because it's demonstrably not converging*, not because a timer expired.

## Non-convergence (trigger → route → park → re-open)

A loop can churn without finishing: CI **ping-pong** (fix A surfaces B, fix B brings A back — often an emergent trade-off), a review-bot **treadmill** (each commit spawns fresh nits), or **wrong-approach whack-a-mole** (each nit is valid but the approach, e.g. a regex, is the problem). A raw attempt counter can't tell these from *legitimate progress* (four independent failures each fixed once) — so the decision is **agent reasoning over the trajectory**, and the split is strict:

- **`pr-snapshot` (babysit) ships facts.** The `trajectory` block is deterministic and coarse: `check_recur_max`/`recurring_checks` (a check that failed → cleared → failed again on a *new* head; same-head flapping is excluded, so this is not flaky noise), `unresolved_trend` + `new_threads_this_tick` (backlog growing / fresh threads arriving), `stream_alternations` (ci↔review bouncing — cross-stream churn only babysit can see), `heads_since_progress` (heads moved without a new low in open problems). Babysit **never** labels this "non-convergence."
- **The leaf judges.** When a trigger fires (the thresholds are in SKILL.md Step 2 — the single source of truth; do not re-list them here), pass the trajectory into that tick's `ce-debug`/`ce-resolve-pr-feedback` as **mandatory input**. It must either demonstrate progress (name the invariant the next bounded fix resolves) or return a `needs-human` that **parks the whole stream** with a `decision_context` (the tension/root, options, tradeoffs, its lean).

**The anti-cry-wolf line (put it to the leaf):** *progressive failure migration* — A fixed → B appears once → B fixed → done — is ordinary repair; **do not park.** *Oscillation* — A returns after B's fix, the failing set cycles, defects migrate X→Y→Z with the same invariant unsatisfied, or fix size grows superlinearly — is non-convergence; park. "We've tried a lot" is never enough.

**Guards:**

- **Moving-target ≠ non-convergence.** Base-branch merges, dep bumps, flaky infra, and bot-rule changes create unrelated new failures. Recurrence already excludes same-SHA flapping; still, don't park a failure the leaf attributes to an external cause rather than the approach.
- **Cross-stream contradiction.** If `ce-debug` concludes the review-requested behavior is invalid while `ce-resolve-pr-feedback` concludes it's required, that's a single **cross-stream** residual — don't arbitrarily park one side.
- **Parked = hard blocker, re-openable.** A parked stream makes the PR *not* merge-ready (never "done"), but re-open it on material change (a human pushed a new head, the parked thread was superseded/resolved, or the failing-check universe changed). **How:** CI re-opens itself — a new head SHA clears the SHA-scoped dispatch state, so just re-snapshot. A parked **review thread** does *not* auto-re-open; `mark --thread <id> --disposition open` re-actionizes it for a fresh pass. Un-park deliberately, on judged material change — not on the resolver's own reply.

## On-disk state contract

State lives at `/tmp/compound-engineering/ce-babysit-pr/<owner>-<repo>-<pr>/state.json` (a stable, cross-invocation-reusable path so any later tick — scheduled or hand-run — finds it). The `pr-snapshot` script owns all reads and writes under a file lock. Shape:

```json
{
  "pr": { "owner": "...", "repo": "...", "number": 123, "url": "..." },
  "head_sha": "abc123",
  "tick": 7,
  "started_at": "<iso8601>",
  "checks": { "<check_key>": { "name": "...", "status": "COMPLETED", "conclusion": "FAILURE", "head_sha": "abc123" } },
  "threads": { "<thread_id>": { "last_comment_id": "...", "last_comment_at": "<iso8601>", "disposition": "open|dispatched|needs-human", "acted_identity": ["<comment_id>", "<comment_at>"] } },
  "ci_dispatched": { "<head_sha>": ["<check_key>", "..."] },
  "review_decision": "APPROVED",
  "mergeable": "MERGEABLE",
  "merge_state_status": "CLEAN",
  "last_change_at": "<iso8601>",
  "last_action": "<short string>",
  "trajectory": {
    "check_history": { "<check_key>": { "state": "failing|clear", "last_head": "abc123", "recur": 0 } },
    "seen_threads": { "<thread_id>": 3 },
    "unresolved_series": [2, 3, 4],
    "stream_series": ["ci", "review", "ci"],
    "min_open_problems": 1,
    "heads_since_progress": 0
  }
}
```

A `check_key` is `"<workflow>/<name>"` (or `"<name>"` when there is no workflow) — stable across polls for the same head, which is all the dedup needs (see below). Each `snapshot` emits `changed_this_tick`, `quiet_seconds`, `session_seconds`, and the derived `trajectory` facts (see **Non-convergence** above). The `trajectory` sub-state is deterministic bookkeeping the script maintains; the leaves reason over the emitted facts.

## Claim → act → confirm (the dedup protocol)

The rule that makes ticks idempotent *and* crash-safe: **the snapshot never marks an item handled just from observing it.** An item leaves the actionable set only when the agent confirms it acted (via `mark`) or when remote truth removes it. So if a resolve/debug pass crashes, errors, or returns without finishing, the item is still actionable on the next tick — the loop cannot silently drop work.

- **Review threads.** A thread is actionable while it is unresolved and you have not recorded acting on it. After a resolve pass, `mark --thread <id> --disposition dispatched` (handled) or `--disposition needs-human` (escalated) silences it. A later fetch drops resolved threads entirely (remote confirms the resolve). A silenced thread stays silenced until it is resolved remotely or you explicitly re-open it with `--disposition open` — new comment activity does **not** auto-reactivate it. This is deliberate: the resolver's own `decision_context` reply changes the thread's last comment, and auto-reactivation would re-trigger (and re-post to) the thread every tick.
- **CI checks.** A failing check on the current head is actionable until you `mark --check <key>` (recorded in `ci_dispatched[head_sha]`). A new head SHA clears `ci_dispatched` and re-evaluates every check against the new commit, so green is never carried across a push. There is no transition-tracking: a failing check simply stays actionable until you record acting on it, which is both simpler and immune to missing an `IN_PROGRESS → FAILURE` edge between polls.

`ci_dispatched` and the thread dispositions **are** the journal — they are written by `mark` and read by `snapshot`. There is no separate crash-recovery record because an un-`mark`ed item is, by construction, still actionable.

## Merge-readiness and the settle window

Do not re-derive "required checks" — GitHub already computes it. Use `mergeable == "MERGEABLE"` and `merge_state_status == "CLEAN"` (branch protection satisfied: required checks green, required review approved, no conflicts). `UNSTABLE` means mergeable but a non-required check is red; `BLOCKED` means a required gate is unmet. The snapshot also emits `has_failing_checks` so you can act on a red check even while `merge_state_status` is `UNSTABLE`.

The settle window guards the most damaging false positive: "CI went green, told the user to merge, then feedback landed."

- The script stamps `last_change_at` whenever anything observable moves — a check status/conclusion, a thread's identity (added, edited, or resolved-away), the head SHA, `review_decision`, `mergeable`, or `merge_state_status`. Each snapshot emits `quiet_seconds`.
- "Looks ready" requires `quiet_seconds >= 300` (default) on top of a CLEAN mergeable state and zero actionable threads. A reviewer or bot still working shows up as recent activity → `quiet_seconds` resets.
- **It is a cooling-off signal, not a guarantee.** Five quiet minutes is evidence the PR stopped moving, not proof no review is coming. Report "looks ready — your call," never "safe to merge." This is why the settle window, not per-bot signal parsing, is the primary guard: it is robust to reviewers you have never seen, and most in-progress activity already resets the clock for free.

## Concurrency

- **Lock.** The script takes a file lock around each state read/write. It cannot span the agent's mutations (which happen between script calls), so it is necessary but not sufficient.
- **Pre-mutation revalidation.** The delegated skills re-check remote before they write, but a second babysitter or a human can still act between your snapshot and your action. Treat the snapshot as a hint, never as a guarantee the world is unchanged at mutation time.

## Edge cases

- **Merge conflict mid-flight** (`mergeable == "CONFLICTING"`): **stop and report.** Do not auto-rebase or force-push — rewriting a PR head branch is destructive and not implied by "babysit."
- **External head change / force-push:** the head SHA moved under the loop. The snapshot clears SHA-scoped CI state automatically; just re-snapshot. Never clobber unrelated pushed work.
- **PR closed or merged externally:** detected as `pr_state != "OPEN"` on any tick → clean exit with a final status.
- **needs-human feedback:** `ce-resolve-pr-feedback` leaves those threads open and returns them as escalations; record each with `mark ... --disposition needs-human`, keep doing independent CI work, and surface them. Never auto-decline or auto-resolve a thread you did not fix. Past a small threshold of accumulated escalations, stop and hand back.
- **No push access / fork PR:** a delegated push will fail. Detect that from the delegated skill's result, report it, and stop — the loop cannot make progress it has no permission to make.
- **CI that never completes:** a check stuck `IN_PROGRESS` for a long time will keep the loop from settling. When the session budget (`session_seconds` cap) is reached, hand back with "CI still running after <N>" rather than looping forever.
- **Rate limits / transient API errors:** honor the reset time, back off, resume. The claim→confirm protocol protects against replay.
