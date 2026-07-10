# Cross-Model Judgment Pass

Runs ce-doc-review's **conditional judgment lenses** through a **different model family than the host**, in separate read-only processes, so their findings are independent of the in-process reviewers. Each peer gets the **same** persona brief the in-process reviewer uses, returns the same `findings-schema.json` shape, and folds into synthesis as reviewer `<reviewer-name>-<peer>` — so agreement between it and the in-process persona promotes the finding (synthesis 3.4 cross-persona agreement; render as `<reviewer-name>, <reviewer-name>-<peer> (+1 anchor)`).

The trio is the three **conditional** judgment lenses whose output diverges most across model families: `adversarial-document-reviewer`, `product-lens-reviewer`, `security-lens-reviewer`. The convergent lenses (`coherence`, `scope-guardian`) and the always-on `feasibility` lens do **not** run cross-model — feasibility is excluded specifically so the pass stays conditional and does not spawn on every review.

All invocation detail (composing the prompt from the persona, embedding the document + context slots, read-only flags, per-lens model, per-peer timeouts, capturing schema-shaped JSON, normalizing the reviewer name) lives in the bundled script **`scripts/cross-model-doc-review.sh`**. This reference decides *whether* to run it, *which lenses*, *which peer*, *which model*, and how to fold the results in. The pass is **non-blocking**: the script logs a reason and exits cleanly on any problem, writing no output file — a missing file is simply "no cross-model pass," never a failure.

## Gate — run only when this holds

Run the cross-model pass for a given trio lens **only when that lens was activated** for this document by the normal Phase 1 persona-selection logic. No new activation triggers are introduced: a routine plan with validated upstream provenance and no high-stakes domain activates none of the trio, so it gets no cross-model pass. The document is already guaranteed readable on disk by Phase 1's missing-document gate — there is no diff and no remote-scope concern, so no additional scope gate is needed.

## Step 1 — Identify host and peer (runtime self-id, no build-time)

```bash
if [ -n "${CURSOR_AGENT:-}${CURSOR_CONVERSATION_ID:-}" ]; then XHOST=cursor; XPEER=codex
elif [ "${CLAUDECODE:-}" = "1" ]; then XHOST=claude; XPEER=codex
elif [ -n "${CODEX_SANDBOX:-}${CODEX_SANDBOX_NETWORK_DISABLED:-}${CODEX_SESSION_ID:-}${CODEX_THREAD_ID:-}${CODEX_CI:-}" ]; then XHOST=codex; XPEER=claude
else XHOST=unknown; XPEER=""; fi
echo "XMODEL_HOST: $XHOST  PEER: ${XPEER:-none}"
```

Cursor and Claude prefer **codex** as the peer (a guaranteed different model family); Codex prefers **claude**. There is no single canonical marker Codex sets across surfaces (CLI, web, CI), and `shell_environment_policy`/IDE inheritance can strip env vars, so check the union above. Do **not** use the *other* CLI's home (e.g. `CODEX_HOME`) — it leaks into a Claude session. `unknown` → skip the pass silently. The script also re-validates the peer it is handed, so a wrong/missing peer fails safe.

## Step 2 — Per-lens peer model

The script owns the mapping; it is repeated here so callers know what runs. `security-lens` is knowledge-bound (flagship model breadth catches threat classes a mid model does not know); `adversarial` and `product-lens` are reasoning-bound (deliberation is the lever, so a mid model at high reasoning fits). Concrete IDs are the current instance of the tier principle — a maintenance point, not the contract.

| Persona file | Reviewer name | Codex peer | Claude peer |
|---|---|---|---|
| `security-lens-reviewer` | `security-lens` | `gpt-5.6-sol`, reasoning medium | `opus`, medium |
| `adversarial-document-reviewer` | `adversarial` | `gpt-5.6-terra`, reasoning high | `sonnet`, high |
| `product-lens-reviewer` | `product-lens` | `gpt-5.6-terra`, reasoning high | `sonnet`, high |

The **persona file** basename and the **reviewer name** are distinct: the script reads the brief from `references/personas/<persona-file>.md` but forces the fold-in `reviewer` field to `<reviewer-name>-<peer>` so agreement matches the in-process persona's short name. The script derives the persona-file from the allowlisted reviewer-name (the table above) — it is **not** a caller argument, so no caller value reaches the brief-read path.

## Step 3 — Announce

- **Interactive host (`claude` or `cursor`), default (non-headless) mode:** surface a **prominent standalone line** that names the peer (the peer CLI, plus model if cheaply known) and states that the judgment lenses are also being reviewed by an independent model family — placed with the Phase 2 team announce, not buried after it. Wording is yours; the falsifiable requirements: prominent, names the peer, reads as coverage not plumbing.
- **Interactive host, peer unavailable** (script will skip — CLI missing/unauthed): one quiet line that the cross-model pass was skipped and why. Never an error.
- **`XHOST=codex`:** announce **nothing** — run or skip silently.
- **Headless mode:** emit no user-facing prose. The script still emits a one-line stderr audit log that document content was sent cross-model to the named peer provider, so the third-party data egress is auditable even though the pass is silent to the user.

## Step 4 — Run the bundled script (one call per activated trio lens, in parallel with the persona reviewers)

Each call is a CLI shell-out, not a subagent, so it doesn't consume the subagent concurrency budget. **Launch one call per activated trio lens as a background shell process in the same dispatch wave as the in-process persona reviewers** so runtime overlaps, then collect before synthesis.

Invoke via the skill-dir anchor — set `SKILL_DIR` to the absolute directory of **this** skill's `SKILL.md` (the Bash tool's CWD is the user's project, not the skill dir, on every host):

```bash
SKILL_DIR="<absolute path of the directory containing the ce-doc-review SKILL.md you read>"
bash "$SKILL_DIR/scripts/cross-model-doc-review.sh" "<peer>" "<reviewer-name>" "<document-path>" "<document-type>" "<origin>" "<run-dir>"
```

- `<peer>` = `XPEER` from Step 1 (`codex` or `claude`).
- `<reviewer-name>` = the activated lens (`security-lens`, `adversarial`, or `product-lens`). The script derives the persona-brief filename and per-lens model from this allowlisted value — the brief path is never caller-controlled.
- `<document-path>` = the document under review.
- `<document-type>` = the Phase 1 classification (`requirements` / `plan` / `unified-requirements` / `unified-plan`).
- `<origin>` = the same `{origin_path}` slot the in-process personas receive.
- `<run-dir>` = a run scratch dir (e.g. `/tmp/compound-engineering/ce-doc-review/<run-id>/`). The script writes `<reviewer-name>-<peer>.json` there.

Set the Bash tool `timeout` to `660000` (11 min) — the script self-bounds (codex idle-timeout default 180s with reasoning forced on for liveness; hard backstop `CROSS_MODEL_HARD_SECS` default 600s) and exits cleanly. If the harness can't background a shell command, run the calls inline before awaiting the reviewers; correctness is unaffected, only wall-clock. The script needs no prompt or schema passed in — it reads the persona brief, `findings-schema.json`, and the document itself from disk.

The cross-model pass does **not** receive the accumulated decision primer that in-process personas get on round 2+ — the peer prompt carries a round-1 framing regardless of round. This is deliberate (cross-model is most valuable on the first pass), and synthesis's own R29/R30 suppression is the authoritative backstop for re-raised or already-resolved findings, so a peer that re-raises a prior-round-rejected finding is dropped at synthesis, not surfaced.

## Step 5 — Fold into synthesis

- Read each `<run-dir>/<reviewer-name>-<peer>.json`. If present, treat it as one reviewer return with `reviewer: <reviewer-name>-<peer>`, exactly like a persona artifact: it enters synthesis 3.3 dedup and 3.4 cross-persona agreement promotion.
- **No file** (script skipped: no peer, CLI missing/unauthed, timeout, unparseable output, or lens not activated) → the pass simply didn't run for that lens. Note "cross-model pass: not run" in Coverage on an interactive host in default mode; stay silent under codex / headless. Never fail the review.
- Empty `findings` → note "cross-model pass: no additional issues" in Coverage.
- A finding sharing a dedup fingerprint with its in-process twin (`<reviewer-name>`) promotes by one anchor step (synthesis 3.4) — the cross-model agreement signal, the strongest in the set (different model families, separate processes).

## Trust boundary (maintainers)

The script embeds the **full document content** into the peer prompt and sends it to an external model provider (OpenAI for the codex peer, Anthropic for the claude peer). This is a wider egress than a diff-only review. The peer runs strictly read-only (codex `-s read-only`; claude `dontAsk` with `Edit`/`Write`/`NotebookEdit`/`Bash`/`Task`/`mcp__*` denied), so impact is bounded to disclosure, not repo mutation — but a document from an untrusted author is also a prompt-injection surface, contained by the read-only posture to disclosure-to-self. The script's stderr audit log records each send so the egress is auditable even in headless mode.
