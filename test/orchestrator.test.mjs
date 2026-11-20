import { test } from "node:test"
import assert from "node:assert/strict"
import { load } from "./helpers.mjs"
import { planSingleTask } from "../src/core/planner.mjs"
import { createLedger, memoryStore } from "../src/core/slots.mjs"
import { runSubtasks } from "../src/core/orchestrator.mjs"

const config = load()
const repo = config.repos[0]
const base = planSingleTask({ config, repo, issue: { number: 1, title: "Parent", body: "" }, runId: "r" })
const sub = (id, dependencies = []) => ({ ...base, taskId: id, parentId: base.taskId, dependencies, idempotencyKey: id })
const ok = (task) => ({ schema: 1, taskId: task.taskId, status: "ok", artifacts: [], summary: "done", usage: { minutes: 1 }, evidence: [] })
const ledgerOf = () => createLedger(memoryStore())
const tick = () => new Promise((resolve) => setImmediate(resolve))

test("never more than four sub-tasks run at once, and all of them finish", async () => {
  let live = 0
  let peak = 0
  const execute = async (task) => {
    live++
    peak = Math.max(peak, live)
    await tick()
    await tick()
    live--
    return ok(task)
  }
  const tasks = Array.from({ length: 10 }, (_, i) => sub(`t${i}`))
  const { results, skipped } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: tasks, execute, leaseMs: 60000 })
  assert.equal(peak, 4)
  assert.equal(Object.keys(results).length, 10)
  assert.deepEqual(skipped, [])
})

test("a task starts only after its dependencies succeeded", async () => {
  const order = []
  const execute = async (task) => { order.push(task.taskId); return ok(task) }
  await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("c", ["b"]), sub("b", ["a"]), sub("a")], execute, leaseMs: 60000 })
  assert.deepEqual(order, ["a", "b", "c"])
})

test("a failed dependency skips its dependents but not independent work", async () => {
  const execute = async (task) => (task.taskId === "a" ? { ...ok(task), status: "failed" } : ok(task))
  const { results, skipped } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a"), sub("b", ["a"]), sub("c")], execute, leaseMs: 60000 })
  assert.deepEqual(skipped, ["b"])
  assert.equal(results.c.status, "ok")
})

test("a throwing or invalid result becomes a failure and still frees the slot", async () => {
  const ledger = ledgerOf()
  const execute = async (task) => {
    if (task.taskId === "x") throw new Error("boom")
    return { status: "ok" }
  }
  const { results } = await runSubtasks({ ledger, parent: base, subtasks: [sub("x"), sub("y")], execute, leaseMs: 60000 })
  assert.match(results.x.summary, /boom/)
  assert.match(results.y.summary, /invalid result/)
  assert.equal(ledger.active(base.taskId), 0)
})

test("an unverifiable 'verified' claim is turned into a failure", async () => {
  const execute = async (task) => ({ ...ok(task), verified: true })
  const { results } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a")], execute, leaseMs: 60000 })
  assert.equal(results.a.status, "failed")
})

test("a result for another task is rejected", async () => {
  const execute = async (task) => ({ ...ok(task), taskId: "someone-else" })
  const { results } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a")], execute, leaseMs: 60000 })
  assert.equal(results.a.status, "failed")
})

test("a dependency cycle or unknown dependency is skipped, not hung", async () => {
  const execute = async (task) => ok(task)
  const { skipped } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a", ["b"]), sub("b", ["a"]), sub("c", ["ghost"])], execute, leaseMs: 60000 })
  assert.deepEqual(skipped.sort(), ["a", "b", "c"])
})

test("invalid sub-tasks are refused before anything runs", async () => {
  const execute = async () => assert.fail("must not run")
  await assert.rejects(runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [{ ...sub("a"), role: "wizard" }], execute, leaseMs: 1 }), /Invalid sub-tasks/)
  await assert.rejects(runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [{ ...sub("a"), parentId: "other" }], execute, leaseMs: 1 }), /parentId/)
})

test("slot events are emitted and a broken emit changes nothing", async () => {
  const events = []
  const execute = async (task) => ok(task)
  await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a")], execute, leaseMs: 1000, emit: (e) => events.push(e.type) })
  assert.deepEqual(events, ["slot.acquire", "slot.release"])
  const { results } = await runSubtasks({ ledger: ledgerOf(), parent: base, subtasks: [sub("a")], execute, leaseMs: 1000, emit: () => { throw new Error("x") } })
  assert.equal(results.a.status, "ok")
})
