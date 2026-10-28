import { test } from "node:test"
import assert from "node:assert/strict"
import { summaryMarkdown, statsRecord, writeJobSummary } from "../src/report.mjs"
import { isTransientAgentFailure } from "../src/guards.mjs"
import { pickWorker } from "../src/workers.mjs"
import { worstPassMinutes, secondPassMinutes, secondPassWait, runBudgetMinutes } from "../src/config.mjs"
import { load, loadError, realConfig } from "./helpers.mjs"

test("the summary names the outcome, worker, time, PR and run, and keeps the table intact", () => {
  const md = summaryMarkdown({ outcome: "review", repo: "o/r", issue: 7, runUrl: "https://x/run/1", info: { worker: "claude-01", agent: "claude", agentMinutes: 3.14159, prUrl: "https://x/pull/2", attempts: 2, reason: "a | b\nc" } })
  assert.match(md, /\*\*review\*\*/)
  assert.match(md, /claude-01 \(claude\)/)
  assert.match(md, /3\.1 min/)
  assert.match(md, /Attempts \| 2/)
  assert.match(md, /a \\\| b c/, "pipes and newlines cannot break the table")
})

test("the stats record is one flat JSON line's worth of facts", () => {
  const r = statsRecord({ outcome: "needs-attention", repo: "o/r", issue: "7", runId: 99, info: { agent: "opencode", worker: "opencode-01", agentMinutes: 1.234 } })
  assert.deepEqual(r, { runId: "99", repo: "o/r", issue: 7, outcome: "needs-attention", agent: "opencode", worker: "opencode-01", agentMinutes: 1.23, attempts: 1 })
})

test("the job summary is only written inside Actions, and a write error never throws", () => {
  assert.equal(writeJobSummary("x", {}), false)
  const lines = []
  assert.equal(writeJobSummary("x", { GITHUB_STEP_SUMMARY: "/f" }, (f, t) => lines.push([f, t])), true)
  assert.deepEqual(lines, [["/f", "x\n"]])
  assert.equal(writeJobSummary("x", { GITHUB_STEP_SUMMARY: "/f" }, () => { throw new Error("disk") }), false)
})

test("provider limits are told apart from real failures", () => {
  for (const t of ["Claude usage limit reached", "Error 429 Too Many Requests", "API overloaded_error: Overloaded", "weekly limit hit", "ECONNRESET", "Please try again later", "quota exceeded"]) assert.ok(isTransientAgentFailure(t), t)
  for (const t of ["SyntaxError: unexpected token", "npm test failed: 3 failing", "exit code 3", "", undefined]) assert.ok(!isTransientAgentFailure(t), String(t))
})

test("pickWorker skips excluded agent types", () => {
  const states = [
    { id: "a", agent: "claude", state: "free" },
    { id: "b", agent: "opencode", state: "free" },
  ]
  assert.equal(pickWorker(states, [], 0, {}, ["claude"]).id, "b")
  assert.equal(pickWorker(states, [], 0, {}, ["claude", "opencode"]), null)
})

test("the pass length and the run budget come from the config, and the budget is validated", () => {
  const c = realConfig()
  assert.equal(worstPassMinutes({ factory: { waitForWorkerMinutes: 20, commandTimeoutMinutes: 25, agentTimeoutMinutes: 30 } }), 155)
  assert.equal(runBudgetMinutes(load()), 155)
  assert.equal(secondPassMinutes({ factory: { waitForWorkerMinutes: 20, commandTimeoutMinutes: 25, agentTimeoutMinutes: 30 } }), 10 + 50 + 30)
  assert.equal(secondPassWait({ factory: { waitForWorkerMinutes: 3 } }), 3)
  assert.equal(runBudgetMinutes({ factory: { runBudgetMinutes: 100 } }), 100)
  assert.match(loadError((x) => (x.factory.runBudgetMinutes = 0)), /runBudgetMinutes must be a positive number/)
  assert.ok(c)
})

import { reviewChange } from "../src/guards.mjs"
import { buildPrBody } from "../src/pr-body.mjs"
import * as host from "../src/git-host.mjs"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ch = (file, status = "M", added = 1, deleted = 0) => ({ file, status, added, deleted })

test("reviewChange refuses a runaway change and says why", () => {
  assert.match(reviewChange(Array.from({ length: 101 }, (_, i) => ch(`f${i}`))).refuse, /101 files/)
  assert.match(reviewChange([ch("a", "M", 4000, 1500)]).refuse, /5500 lines/)
  assert.equal(reviewChange([ch("a", "M", 4000, 1000)]).refuse, null)
  assert.match(reviewChange([ch("a", "M", 30, 0)], { maxChangedLines: 10 }).refuse, /10/)
  assert.equal(reviewChange(Array.from({ length: 101 }, (_, i) => ch(`f${i}`)), { maxFiles: 200 }).refuse, null)
})

test("reviewChange refuses lockfile-only and test-deletion-only changes, and flags the rest", () => {
  assert.match(reviewChange([ch("package-lock.json")]).refuse, /lockfiles/)
  assert.match(reviewChange([ch("test/a.test.mjs", "D", 0, 40), ch("src/x.spec.ts", "D", 0, 9)]).refuse, /only deletes test files/)
  const mixed = reviewChange([ch("src/a.js"), ch("test/a.test.mjs", "D", 0, 40), ch("package-lock.json")])
  assert.equal(mixed.refuse, null)
  assert.equal(mixed.flags.length, 2)
  assert.match(mixed.flags[0], /Deletes 1 test file/)
  assert.deepEqual(reviewChange([]), { refuse: null, flags: [] })
})

test("stagedChanges reports status and line counts, deletions and renames included", () => {
  const dir = mkdtempSync(join(tmpdir(), "staged-"))
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "init.defaultBranch=main", ...a], { cwd: dir, encoding: "utf8" })
  try {
    g("init", "-q")
    mkdirSync(join(dir, "test"))
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n")
    writeFileSync(join(dir, "test", "t.test.js"), "x\ny\n")
    writeFileSync(join(dir, "old.txt"), "keep\n")
    g("add", "-A")
    g("commit", "-qm", "base")
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n")
    rmSync(join(dir, "test", "t.test.js"))
    g("mv", "old.txt", "new.txt")
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]))
    g("add", "-A")
    const byFile = Object.fromEntries(host.stagedChanges(dir).map((c) => [c.file, c]))
    assert.deepEqual(byFile["a.txt"], { status: "M", file: "a.txt", added: 2, deleted: 0 })
    assert.deepEqual(byFile["test/t.test.js"], { status: "D", file: "test/t.test.js", added: 0, deleted: 2 })
    assert.equal(byFile["old.txt"].status, "D")
    assert.equal(byFile["new.txt"].status, "A")
    assert.deepEqual(byFile["bin.dat"], { status: "A", file: "bin.dat", added: null, deleted: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the pull request body separates the agent's text from the factory's facts", () => {
  const body = buildPrBody({ issueNumber: 7, summary: "I did it.", workerId: "claude-01", agent: "claude", checks: ["npm test"], runUrl: "https://x/run", changes: [ch("a.js", "M", 3, 1), ch("b.bin", "A", null, null), ch("c.js", "D", 0, 9)], flags: ["Deletes 1 test file(s)."] })
  assert.match(body, /^Closes #7\n\nI did it\./)
  assert.match(body, /- `a\.js` \(changed, \+3 -1\)/)
  assert.match(body, /- `b\.bin` \(added, binary\)/)
  assert.match(body, /- `c\.js` \(deleted, \+0 -9\)/)
  assert.match(body, /## For the reviewer\n- Deletes 1 test file/)
  assert.match(body, /`claude-01` \(claude\).*`npm test`.*\[Factory run\]\(https:\/\/x\/run\)/s)
  assert.match(buildPrBody({ issueNumber: 1, summary: "", workerId: "w", agent: "a" }), /\(The agent gave no summary\.\)[\s\S]*no automated checks/)
})

test("a long file list is cut, and says how many are missing", () => {
  const body = buildPrBody({ issueNumber: 1, summary: "s", workerId: "w", agent: "a", changes: Array.from({ length: 45 }, (_, i) => ch(`f${i}.js`)) })
  assert.match(body, /\.\.\.and 15 more/)
  assert.doesNotMatch(body, /f44\.js/)
})

test("per-repo limits must be positive whole numbers", () => {
  assert.match(loadError((c) => (c.repos[0].limits = { maxFiles: 0 })), /limits\.maxFiles must be a positive whole number/)
  assert.match(loadError((c) => (c.repos[0].limits = { maxChangedLines: 1.5 })), /limits\.maxChangedLines/)
  assert.ok(load((c) => (c.repos[0].limits = { maxFiles: 10, maxChangedLines: 100 })))
})

import { aggregateStats } from "../src/report.mjs"
import { claimState, describeWorkers, advice } from "../src/ops.mjs"

test("aggregateStats totals runs per outcome and agent, skips junk, and counts a run once", () => {
  const rec = (o) => `2026-10-28T10:00:00Z ##[notice]::notice title=factory-stats::${JSON.stringify(o)}`
  const log = [
    rec({ runId: "1", repo: "o/r", issue: 1, outcome: "review", agent: "claude", agentMinutes: 4.5 }),
    rec({ runId: "2", repo: "o/r", issue: 2, outcome: "needs-attention", agent: "claude", agentMinutes: 1.5 }),
    rec({ runId: "3", repo: "o/r", issue: 3, outcome: "review", agent: "opencode", agentMinutes: 10 }),
    rec({ runId: "3", repo: "o/r", issue: 3, outcome: "review", agent: "opencode", agentMinutes: 10 }),
    "noise without the marker",
    "title=factory-stats::{not json",
    rec({ runId: "4", repo: "o/r", issue: 4, outcome: "skipped", agent: null, agentMinutes: 0 }),
  ].join("\n")
  const s = aggregateStats(log)
  assert.equal(s.runs, 4)
  assert.deepEqual(s.outcomes, { review: 2, "needs-attention": 1, skipped: 1 })
  assert.deepEqual(s.byAgent.claude, { runs: 2, review: 1, minutes: 6, successRate: 0.5 })
  assert.deepEqual(s.byAgent.opencode, { runs: 1, review: 1, minutes: 10, successRate: 1 })
  assert.equal(s.agentMinutes, 16)
  assert.deepEqual(aggregateStats(""), { runs: 0, outcomes: {}, byAgent: {}, agentMinutes: 0 })
})

test("claimState tells live, finished, unknown and local claims apart, and a lookup error is unknown", async () => {
  assert.deepEqual(await claimState("run-5", async () => ({ status: "in_progress" })), { label: "run-5", runId: "5", state: "live", conclusion: null, url: null })
  assert.equal((await claimState("run-5", async () => ({ status: "completed", conclusion: "cancelled", html_url: "u" }))).state, "finished")
  assert.equal((await claimState("run-5", async () => null)).state, "unknown")
  assert.equal((await claimState("run-5", async () => { throw new Error("boom") })).state, "unknown")
  assert.deepEqual(await claimState("run-local123", async () => assert.fail("never asked")), { label: "run-local123", state: "local" })
})

test("describeWorkers and advice point at what to do", async () => {
  const states = [
    { id: "a", agent: "claude", state: "busy", boxStatus: "running", boxId: "b1", runs: ["run-1"] },
    { id: "b", agent: "opencode", state: "busy", boxStatus: "running", boxId: "b2", runs: ["run-2"] },
    { id: "c", agent: "opencode", state: "busy", boxStatus: "paused", boxId: "b3", runs: [] },
    { id: "d", agent: "claude", state: "free", boxStatus: "paused", boxId: "b4", runs: [] },
  ]
  const rows = await describeWorkers(states, async (id) => (id === "1" ? { status: "completed", conclusion: "failure" } : null))
  assert.deepEqual(rows[0].stale, ["run-1"])
  assert.deepEqual(rows[1].claims.map((c) => c.state), ["unknown"])
  const todo = advice(rows)
  assert.equal(todo.length, 3)
  assert.match(todo[0], /^a: run-1 finished.*reap-stale/)
  assert.match(todo[1], /^b: a claim cannot be checked.*release-worker\.mjs b/)
  assert.match(todo[2], /^c: busy without any run label/)
  assert.deepEqual(advice(await describeWorkers([states[3]], async () => null)), [])
})
