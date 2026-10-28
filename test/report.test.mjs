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
