import { test } from "node:test"
import assert from "node:assert/strict"
import { load } from "./helpers.mjs"
import { validateTask, validateResult } from "../src/core/contracts.mjs"
import { planSingleTask } from "../src/core/planner.mjs"
import { can, capabilitiesOf, checkModelAssignment, hasFreeSlot, MAX_ACTIVE_SUBAGENTS } from "../src/core/policy.mjs"
import { makeEvent, appendEvent, EVENT_TYPES } from "../src/core/events.mjs"

const config = load()
const repo = config.repos[0]
const issue = { number: 12, title: "Add the line", body: "Please add it." }
const task = () => planSingleTask({ config, repo, issue, runId: "4001" })

test("the planned task is valid and mirrors what runIssue does today", () => {
  const t = task()
  assert.equal(validateTask(t).ok, true)
  assert.equal(t.role, "developer")
  assert.equal(t.parentId, null)
  assert.equal(t.assignedModel, null, "the model is the CLI default until the router exists")
  assert.deepEqual(t.acceptance, repo.checks)
  assert.equal(t.taskId, `${repo.repo}#12@4001`)
  assert.equal(t.status, "queued")
})

test("planning is deterministic: the same issue gives the same idempotency key across runs", () => {
  assert.equal(planSingleTask({ config, repo, issue, runId: "1" }).idempotencyKey, planSingleTask({ config, repo, issue, runId: "2" }).idempotencyKey)
  assert.notEqual(planSingleTask({ config, repo, issue: { ...issue, number: 13 }, runId: "1" }).idempotencyKey, task().idempotencyKey)
})

test("validateTask lists every problem", () => {
  const { ok, errors } = validateTask({ ...task(), role: "wizard", budget: { minutes: 0, attempts: 0 }, authorizedTools: ["root"], status: "done" })
  assert.equal(ok, false)
  assert.ok(errors.length >= 4, errors.join("; "))
  assert.equal(validateTask(null).ok, false)
})

test("a task cannot depend on itself, and assignment fields must be null or real", () => {
  const t = task()
  assert.equal(validateTask({ ...t, dependencies: [t.taskId] }).ok, false)
  assert.equal(validateTask({ ...t, assignedModel: "" }).ok, false)
  assert.equal(validateTask({ ...t, assignedModel: "some-model" }).ok, true)
})

test("a result is 'verified' only with recorded evidence", () => {
  const base = { schema: 1, taskId: "t", status: "ok", artifacts: [], summary: "done", usage: { minutes: 3 }, evidence: [] }
  assert.equal(validateResult(base).ok, true)
  assert.equal(validateResult({ ...base, verified: true }).ok, false, "no evidence")
  assert.equal(validateResult({ ...base, verified: true, evidence: [{ command: "npm test", exit: 1 }] }).ok, false, "failing evidence")
  assert.equal(validateResult({ ...base, verified: true, evidence: [{ command: "npm test", exit: 0 }] }).ok, true)
  assert.equal(validateResult({ ...base, evidence: [{ command: "npm test" }] }).ok, false, "exit code is required")
})

test("only the Main Agent and a factory admin may assign models; sub-agents may not", () => {
  assert.equal(can({ type: "main" }, "agent.assign_model"), true)
  assert.equal(can({ type: "human", role: "factory-admin" }, "agent.assign_model"), true)
  for (const actor of [{ type: "sub" }, { type: "system" }, { type: "human", role: "operator" }, { type: "human" }, null, { type: "root" }]) {
    assert.equal(can(actor, "agent.assign_model"), false, JSON.stringify(actor))
  }
})

test("sub-agents can only report: no create, stop or model change", () => {
  assert.deepEqual(capabilitiesOf({ type: "sub" }), ["task.report"])
  assert.equal(can({ type: "sub" }, "agent.create"), false)
  assert.equal(can({ type: "sub" }, "agent.stop"), false)
})

test("a model assignment needs a reason", () => {
  assert.equal(checkModelAssignment({ type: "main" }, {}).ok, false)
  assert.equal(checkModelAssignment({ type: "main" }, { reason: "  " }).ok, false)
  assert.equal(checkModelAssignment({ type: "main" }, { reason: "complex task" }).ok, true)
  assert.equal(checkModelAssignment({ type: "sub" }, { reason: "please" }).ok, false)
})

test("the cap is exactly four active sub-agents", () => {
  assert.equal(MAX_ACTIVE_SUBAGENTS, 4)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(hasFreeSlot), [true, true, true, true, false, false])
  assert.equal(hasFreeSlot(-1), false)
  assert.equal(hasFreeSlot(1.5), false)
  assert.equal(hasFreeSlot(undefined), false)
})

test("events are masked, typed and carry an actor", () => {
  const redact = (s) => s.replaceAll("SECRET-VALUE-1", "***")
  const e = makeEvent({ type: "guard.hit", taskId: "t", runId: 77, actor: { type: "system" }, data: { note: "found SECRET-VALUE-1", nested: ["x SECRET-VALUE-1"] } }, { redact, now: new Date("2026-11-20T10:00:00Z"), id: "id-1" })
  assert.equal(e.ts, "2026-11-20T10:00:00.000Z")
  assert.equal(e.runId, "77")
  assert.equal(JSON.stringify(e).includes("SECRET-VALUE-1"), false)
  assert.throws(() => makeEvent({ type: "nonsense", actor: { type: "system" } }), /Unknown event type/)
  assert.throws(() => makeEvent({ type: EVENT_TYPES[0], actor: { type: "robot" } }), /actor/)
})

test("appendEvent writes one JSON line, writes nothing without a file, and never throws", () => {
  const lines = []
  const e = makeEvent({ type: "task.state", actor: { type: "system" } })
  assert.equal(appendEvent(e, "events.jsonl", (f, line) => lines.push([f, line])), true)
  assert.equal(lines[0][1].endsWith("\n"), true)
  assert.deepEqual(JSON.parse(lines[0][1]), e)
  assert.equal(appendEvent(e, undefined, () => assert.fail("must not write")), false)
  assert.equal(appendEvent(e, "x", () => { throw new Error("disk full") }), false)
})
