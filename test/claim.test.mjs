import { test } from "node:test"
import assert from "node:assert/strict"
import { claimWorker, runLabelFor } from "../src/box.mjs"
import { load, fakeBox } from "./helpers.mjs"

// Worker states come from the Boxes' labels, like getWorkerStates does.
function pool(config, boxes) {
  return async () =>
    config.workers.map((worker) => {
      const box = boxes.find((b) => b.name === `${config.factory.boxNamePrefix}${worker.id}`)
      const state = !worker.enabled ? "disabled" : box?.labelSet.has(config.factory.busyLabel) ? "busy" : "free"
      return { ...worker, boxName: box?.name, boxId: box?.id ?? null, boxStatus: box?.status ?? "not created", state }
    })
}

const quiet = () => {}
const noWait = async () => {}

function setup(mutate) {
  const config = load((c) => {
    c.factory.waitForWorkerMinutes = 0.001 // a few milliseconds
    mutate?.(c)
  })
  const boxes = config.workers.map((w) => fakeBox({ id: `id-${w.id}`, name: `${config.factory.boxNamePrefix}${w.id}`, labels: [config.factory.boxLabel, `agent-${w.agent}`] }))
  const deps = { getStates: pool(config, boxes), getBox: async (id) => boxes.find((b) => b.id === id), createBox: async () => assert.fail("no Box should be created"), sleep: noWait, log: quiet }
  return { config, boxes, deps }
}

test("a single run claims a free worker and marks it busy", async () => {
  const { config, boxes, deps } = setup()
  const claim = await claimWorker(config, ["ready", "agent:claude"], "1000", deps)
  assert.equal(claim.worker.id, "claude-01")
  const box = boxes.find((b) => b.id === "id-claude-01")
  assert.ok(box.labelSet.has(config.factory.busyLabel))
  assert.ok(box.labelSet.has(runLabelFor("1000")))
  assert.equal(box.status, "running")
})

test("two runs racing for the only worker: exactly one gets it", async () => {
  const { config, boxes, deps } = setup((c) => (c.workers = c.workers.filter((w) => w.agent === "claude")))
  // Both see the worker free, because neither has added a label yet.
  const [a, b] = await Promise.all([claimWorker(config, ["agent:claude"], "2001", deps), claimWorker(config, ["agent:claude"], "2002", deps)])
  const winners = [a, b].filter(Boolean)
  assert.equal(winners.length, 1, "exactly one claim succeeds")
  const runLabels = [...boxes[0].labelSet].filter((l) => l.startsWith("run-"))
  assert.deepEqual(runLabels, [winners[0].runLabel], "only the winner's run label is left on the Box")
})

test("a late claimer does not join a Box another run already holds", async () => {
  const { config, boxes, deps } = setup((c) => (c.workers = c.workers.filter((w) => w.agent === "claude")))
  // The worker list says free, but the Box already carries a rival's labels.
  boxes[0].labelSet.add("run-1").add(config.factory.busyLabel)
  const staleStates = async () => (await pool(config, []).call()).map((w) => ({ ...w, boxId: boxes[0].id, state: "free" }))
  const claim = await claimWorker(config, ["agent:claude"], "3000", { ...deps, getStates: staleStates })
  assert.equal(claim, null)
  assert.ok(!boxes[0].labelSet.has(runLabelFor("3000")))
})

test("gives up when no worker frees up in time", async () => {
  const { config, boxes, deps } = setup()
  for (const box of boxes) box.labelSet.add(config.factory.busyLabel)
  assert.equal(await claimWorker(config, [], "4000", deps), null)
})
