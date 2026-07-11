import { describe, expect, test, beforeEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Regression tests for the ce-babysit-pr pr-snapshot claim->act->confirm engine.
// Exercised via --fetch-file (no live PR), following the tests/*-validator.test.ts
// spawnSync pattern. Locks in the ce-code-review fixes: crash-safety, needs-human
// silencing + open_needs_human visibility, checks_terminal, key-collision, null-head.
const SCRIPT = path.join(import.meta.dir, "..", "skills", "ce-babysit-pr", "scripts", "pr-snapshot")

function fetchFile(dir: string, name: string, obj: unknown): string {
  const p = path.join(dir, name)
  writeFileSync(p, JSON.stringify(obj))
  return p
}

function snapshot(stateDir: string, fetch: string): any {
  const r = spawnSync(
    "python3",
    [SCRIPT, "snapshot", "--pr", "1", "--repo", "o/r", "--state-dir", stateDir, "--fetch-file", fetch],
    { encoding: "utf8" },
  )
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout)
}

function mark(stateDir: string, args: string[]): void {
  const r = spawnSync("python3", [SCRIPT, "mark", "--state-dir", stateDir, ...args], { encoding: "utf8" })
  expect(r.status, r.stderr).toBe(0)
}

const FAILING = {
  pr_state: "OPEN",
  mergeable: "MERGEABLE",
  merge_state_status: "BLOCKED",
  review_decision: "REVIEW_REQUIRED",
  head_sha: "s1",
  url: "http://x/1",
  checks: [{ key: "CI/test", name: "test", status: "COMPLETED", conclusion: "FAILURE", details_url: "u" }],
  threads: [{ thread_id: "T1", last_comment_id: "C1", last_comment_at: "t1" }],
}

describe("ce-babysit-pr pr-snapshot engine", () => {
  let dir: string
  let state: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prsnap-"))
    state = path.join(dir, "state")
  })

  test("first snapshot: thread + failing check are actionable; checks terminal", () => {
    const d = snapshot(state, fetchFile(dir, "a.json", FAILING))
    expect(d.counts.threads).toBe(1)
    expect(d.counts.ci).toBe(1)
    expect(d.has_failing_checks).toBe(true)
    expect(d.checks_terminal).toBe(true)
  })

  test("crash-safety: un-marked items stay actionable on the next tick", () => {
    const f = fetchFile(dir, "a.json", FAILING)
    const first = snapshot(state, f)
    const second = snapshot(state, f)
    expect(second.counts.threads).toBe(first.counts.threads)
    expect(second.counts.ci).toBe(first.counts.ci)
  })

  test("needs-human thread: silenced despite the resolver's own reply moving identity, but stays visible via open_needs_human", () => {
    snapshot(state, fetchFile(dir, "a.json", FAILING))
    mark(state, ["--thread", "T1", "--disposition", "needs-human"])
    // The resolver posts decision_context, moving the thread's last-comment identity.
    const replied = { ...FAILING, threads: [{ thread_id: "T1", last_comment_id: "C2", last_comment_at: "t2" }] }
    const d = snapshot(state, fetchFile(dir, "b.json", replied))
    expect(d.counts.threads).toBe(0) // no re-actionize (the P1 fix)
    expect(d.open_needs_human).toBe(1) // still blocks merge-ready
  })

  test("mark --check silences it; a new head SHA re-actionizes", () => {
    const f = fetchFile(dir, "a.json", FAILING)
    snapshot(state, f)
    mark(state, ["--check", "CI/test"])
    expect(snapshot(state, f).counts.ci).toBe(0)
    const newHead = { ...FAILING, head_sha: "s2" }
    expect(snapshot(state, fetchFile(dir, "c.json", newHead)).counts.ci).toBe(1)
  })

  test("checks_terminal is false while a check is IN_PROGRESS; all_checks_ok stays false", () => {
    const inprog = {
      ...FAILING,
      checks: [{ key: "CI/test", name: "test", status: "IN_PROGRESS", conclusion: null, details_url: "u" }],
    }
    const d = snapshot(state, fetchFile(dir, "ip.json", inprog))
    expect(d.checks_terminal).toBe(false)
    expect(d.all_checks_ok).toBe(false)
    expect(d.has_failing_checks).toBe(false)
  })

  test("clean + terminal + approved: all_checks_ok true, mergeStateStatus passthrough, no open needs-human", () => {
    const clean = {
      ...FAILING,
      merge_state_status: "CLEAN",
      review_decision: "APPROVED",
      checks: [{ key: "CI/test", name: "test", status: "COMPLETED", conclusion: "SUCCESS", details_url: "u" }],
      threads: [],
    }
    const d = snapshot(state, fetchFile(dir, "cl.json", clean))
    expect(d.all_checks_ok).toBe(true)
    expect(d.checks_terminal).toBe(true)
    expect(d.merge_state_status).toBe("CLEAN")
    expect(d.open_needs_human).toBe(0)
  })

  test("colliding check keys are disambiguated (both failing checks surface, neither shadows)", () => {
    const collide = {
      ...FAILING,
      checks: [
        { key: "test", name: "test", status: "COMPLETED", conclusion: "FAILURE", details_url: "u1" },
        { key: "test", name: "test", status: "COMPLETED", conclusion: "FAILURE", details_url: "u2" },
      ],
    }
    expect(snapshot(state, fetchFile(dir, "co.json", collide)).counts.ci).toBe(2)
  })

  test("transient null head falls back to the last known head — no ci_dispatched wipe / re-dispatch thrash", () => {
    const f = fetchFile(dir, "a.json", FAILING)
    snapshot(state, f)
    mark(state, ["--check", "CI/test"])
    const nullHead = { ...FAILING, head_sha: null }
    const d = snapshot(state, fetchFile(dir, "nh.json", nullHead))
    expect(d.head_changed).toBe(false)
    expect(d.counts.ci).toBe(0) // still silenced
  })

  // --- trajectory: deterministic cross-tick facts for non-convergence detection ---
  const GREEN_CHECK = { key: "CI/test", name: "test", status: "COMPLETED", conclusion: "SUCCESS", details_url: "u" }
  const RED_CHECK = { key: "CI/test", name: "test", status: "COMPLETED", conclusion: "FAILURE", details_url: "u" }

  test("check recurrence: fail -> clear -> fail on a NEW head increments recur (ping-pong signal)", () => {
    snapshot(state, fetchFile(dir, "r1.json", { ...FAILING, head_sha: "s1", checks: [RED_CHECK] }))
    snapshot(state, fetchFile(dir, "r2.json", { ...FAILING, head_sha: "s2", checks: [GREEN_CHECK] }))
    const d = snapshot(state, fetchFile(dir, "r3.json", { ...FAILING, head_sha: "s3", checks: [RED_CHECK] }))
    expect(d.trajectory.check_recur_max).toBe(1)
    expect(d.trajectory.recurring_checks).toEqual([{ key: "CI/test", recur: 1 }])
  })

  test("same-head flapping is NOT recurrence (flaky, not ping-pong)", () => {
    const f = { ...FAILING, head_sha: "s1" }
    snapshot(state, fetchFile(dir, "f1.json", { ...f, checks: [RED_CHECK] }))
    snapshot(state, fetchFile(dir, "f2.json", { ...f, checks: [GREEN_CHECK] }))
    const d = snapshot(state, fetchFile(dir, "f3.json", { ...f, checks: [RED_CHECK] }))
    expect(d.trajectory.check_recur_max).toBe(0)
  })

  test("review backlog trend rises and new-thread arrivals are counted (treadmill signal)", () => {
    const th = (ids: string[]) => ids.map((id) => ({ thread_id: id, last_comment_id: `c-${id}`, last_comment_at: id }))
    snapshot(state, fetchFile(dir, "t1.json", { ...FAILING, checks: [], threads: th(["T1"]) }))
    snapshot(state, fetchFile(dir, "t2.json", { ...FAILING, checks: [], threads: th(["T1", "T2"]) }))
    const d = snapshot(state, fetchFile(dir, "t3.json", { ...FAILING, checks: [], threads: th(["T1", "T2", "T3", "T4"]) }))
    expect(d.trajectory.unresolved_trend).toBe("rising")
    expect(d.trajectory.new_threads_this_tick).toBe(2) // T3, T4 are new this tick
    expect(d.trajectory.unresolved_threads).toBe(4)
  })

  test("check_recur_max does not stay elevated after the recurring check leaves CI (stale-key prune)", () => {
    snapshot(state, fetchFile(dir, "p1.json", { ...FAILING, head_sha: "s1", checks: [RED_CHECK] }))
    snapshot(state, fetchFile(dir, "p2.json", { ...FAILING, head_sha: "s2", checks: [GREEN_CHECK] }))
    expect(snapshot(state, fetchFile(dir, "p3.json", { ...FAILING, head_sha: "s3", checks: [RED_CHECK] })).trajectory.check_recur_max).toBe(1)
    // CI/test is gone from the run (renamed/removed); its recurrence must not linger.
    const other = { key: "CI/other", name: "other", status: "COMPLETED", conclusion: "SUCCESS", details_url: "u" }
    const d = snapshot(state, fetchFile(dir, "p4.json", { ...FAILING, head_sha: "s4", checks: [other] }))
    expect(d.trajectory.check_recur_max).toBe(0)
  })

  test("heads_since_progress climbs on a persistent failure across heads, but resets on progressive migration", () => {
    // Same check red across three new heads with nothing clearing = a stall.
    snapshot(state, fetchFile(dir, "s1.json", { ...FAILING, head_sha: "h1", checks: [RED_CHECK], threads: [] }))
    expect(snapshot(state, fetchFile(dir, "s2.json", { ...FAILING, head_sha: "h2", checks: [RED_CHECK], threads: [] })).trajectory.heads_since_progress).toBe(1)
    expect(snapshot(state, fetchFile(dir, "s3.json", { ...FAILING, head_sha: "h3", checks: [RED_CHECK], threads: [] })).trajectory.heads_since_progress).toBe(2)
    // A different check now fails (A cleared, B appeared) = progressive migration, not a stall -> reset.
    const other = { key: "CI/other", name: "other", status: "COMPLETED", conclusion: "FAILURE", details_url: "u" }
    expect(snapshot(state, fetchFile(dir, "s4.json", { ...FAILING, head_sha: "h4", checks: [other], threads: [] })).trajectory.heads_since_progress).toBe(0)
  })

  test("parking a thread counts as progress: it leaves the non-parked problem set, so no-progress resets", () => {
    const withThread = (headSha: string) => ({
      ...FAILING,
      head_sha: headSha,
      checks: [RED_CHECK],
      threads: [{ thread_id: "T1", last_comment_id: "c1", last_comment_at: "t1" }],
    })
    snapshot(state, fetchFile(dir, "pk1.json", withThread("h1"))) // problems: {CI/test, T1}
    mark(state, ["--thread", "T1", "--disposition", "needs-human"])
    // New head, CI/test still red, T1 now parked (excluded from problems) -> total drops 2->1 = a new low.
    const d = snapshot(state, fetchFile(dir, "pk2.json", withThread("h2")))
    expect(d.open_needs_human).toBe(1)
    expect(d.trajectory.heads_since_progress).toBe(0) // progress was made (a problem left the set), despite the head change
  })

  test("a rerun (IN_PROGRESS) is not a clear — no false recurrence when it fails again", () => {
    snapshot(state, fetchFile(dir, "ir1.json", { ...FAILING, head_sha: "s1", checks: [RED_CHECK] }))
    const rerun = { ...FAILING, head_sha: "s2", checks: [{ key: "CI/test", name: "test", status: "IN_PROGRESS", conclusion: null, details_url: "u" }] }
    snapshot(state, fetchFile(dir, "ir2.json", rerun))
    const d = snapshot(state, fetchFile(dir, "ir3.json", { ...FAILING, head_sha: "s3", checks: [RED_CHECK] }))
    expect(d.trajectory.check_recur_max).toBe(0)
  })

  test("mark --disposition open re-actionizes a parked needs-human thread (the re-open path)", () => {
    const f = fetchFile(dir, "ro.json", FAILING)
    snapshot(state, f)
    mark(state, ["--thread", "T1", "--disposition", "needs-human"])
    expect(snapshot(state, f).open_needs_human).toBe(1) // parked, not actionable
    mark(state, ["--thread", "T1", "--disposition", "open"])
    const d = snapshot(state, f)
    expect(d.counts.threads).toBe(1) // re-opened -> actionable again
    expect(d.open_needs_human).toBe(0)
  })

  test("a fork-PR workflow awaiting maintainer approval blocks 'all_checks_ok' and flags blocked_external", () => {
    const gated = {
      ...FAILING,
      merge_state_status: "UNSTABLE",
      review_decision: "",
      checks: [{ key: "Track", name: "Track", status: "COMPLETED", conclusion: "SUCCESS", details_url: "u" }],
      threads: [],
      awaiting_approval: 1, // real CI hasn't run — awaiting a base-repo maintainer's approval
    }
    const d = snapshot(state, fetchFile(dir, "aa.json", gated))
    expect(d.checks_awaiting_approval).toBe(1)
    expect(d.has_failing_checks).toBe(false)
    expect(d.all_checks_ok).toBe(false) // not "ok" — the gated CI is invisible to the rollup
    expect(d.blocked_external).toBe(true)
  })

  test("cross-stream alternation: ci-only then review-only then ci-only ticks flip (churn signal)", () => {
    const th = (ids: string[]) => ids.map((id) => ({ thread_id: id, last_comment_id: `c-${id}`, last_comment_at: id }))
    snapshot(state, fetchFile(dir, "a1.json", { ...FAILING, head_sha: "s1", checks: [RED_CHECK], threads: [] }))
    snapshot(state, fetchFile(dir, "a2.json", { ...FAILING, head_sha: "s2", checks: [GREEN_CHECK], threads: th(["T1"]) }))
    const d = snapshot(state, fetchFile(dir, "a3.json", { ...FAILING, head_sha: "s3", checks: [RED_CHECK], threads: [] }))
    expect(d.trajectory.stream_alternations).toBe(2) // ci -> review -> ci
  })
})
