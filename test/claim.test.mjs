import { test } from "node:test"
import assert from "node:assert/strict"
import { claimWorker, releaseWorker, runLabelFor } from "../src/box.mjs"
import { load, fakeBox } from "./helpers.mjs"

// Worker states come from the Boxes' labels, the way getWorkerStates does it.
function pool(config, boxes) {
  return async () =>
    config.workers.map((worker) => {
      const box = boxes.find((b) => b.name === `${config.factory.boxNamePrefix}${worker.id}`)
      const held = box && [...box.labelSet].some((l) => l === config.factory.busyLabel || l.startsWith("run-"))
      return { ...worker, boxName: box?.name, boxId: box?.id ?? null, boxStatus: box?.status ?? "not created", state: !worker.enabled ? "disabled" : held ? "busy" : "free" }
    })
}

const quiet = () => {}
// Real but tiny random waits, so racing claimers interleave differently each time.
const jitter = async () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3))

function setup(mutate) {
  const config = load((c) => {
    c.factory.waitForWorkerMinutes = 0.02 // about a second
    mutate?.(c)
  })
  const boxes = config.workers.map((w) => fakeBox({ id: `id-${w.id}`, name: `${config.factory.boxNamePrefix}${w.id}`, labels: [config.factory.boxLabel, `agent-${w.agent}`] }))
  const deps = { getStates: pool(config, boxes), getBox: async (id) => boxes.find((b) => b.id === id), createBox: async () => assert.fail("no Box should be created"), sleep: jitter, log: quiet }
  return { config, boxes, deps }
}
const onlyClaude = (c) => (c.workers = c.workers.filter((w) => w.agent === "claude"))
const runLabels = (box) => [...box.labelSet].filter((l) => l.startsWith("run-"))

test("a single run claims a free worker, marks it busy and wakes it", async () => {
  const { config, boxes, deps } = setup()
  const claim = await claimWorker(config, ["ready", "agent:claude"], "1000", deps)
  assert.equal(claim.worker.id, "claude-01")
  const box = boxes.find((b) => b.id === "id-claude-01")
  assert.ok(box.labelSet.has(config.factory.busyLabel))
  assert.deepEqual(runLabels(box), [runLabelFor("1000")])
  assert.equal(box.status, "running")
})

test("many runs racing for the only worker: never two owners", async () => {
  for (let round = 0; round < 25; round++) {
    const { config, boxes, deps } = setup(onlyClaude)
    const runs = ["3001", "3002", "3003", "3004"]
    const claims = await Promise.all(runs.map((id) => claimWorker(config, ["agent:claude"], id, deps)))
    const winners = claims.filter(Boolean)
    assert.ok(winners.length <= 1, `round ${round}: ${winners.length} owners`)
    // The Box carries exactly the winner's run label, or none at all.
    assert.deepEqual(runLabels(boxes[0]), winners.map((w) => w.runLabel), `round ${round}`)
    assert.equal(boxes[0].labelSet.has(config.factory.busyLabel), winners.length === 1, `round ${round}: busy only with an owner`)
  }
})

test("a race is usually won by someone, not lost by all", async () => {
  let won = 0
  for (let round = 0; round < 10; round++) {
    const { config, deps } = setup(onlyClaude)
    const claims = await Promise.all(["4001", "4002"].map((id) => claimWorker(config, ["agent:claude"], id, deps)))
    if (claims.some(Boolean)) won++
  }
  assert.ok(won >= 8, `only ${won}/10 races had a winner`)
})

test("two workers, two racing runs: each gets its own", async () => {
  const { config, deps } = setup((c) => (c.workers = [{ id: "claude-01", agent: "claude" }, { id: "claude-02", agent: "claude" }]))
  const [a, b] = await Promise.all([claimWorker(config, [], "5001", deps), claimWorker(config, [], "5002", deps)])
  assert.ok(a && b)
  assert.notEqual(a.worker.id, b.worker.id)
})

test("a late claimer working from an old worker list does not join a held Box", async () => {
  const { config, boxes, deps } = setup(onlyClaude)
  boxes[0].labelSet.add("run-1").add(config.factory.busyLabel)
  const stale = async () => (await pool(config, [])()).map((w) => ({ ...w, boxId: boxes[0].id, state: "free" }))
  assert.equal(await claimWorker(config, ["agent:claude"], "6000", { ...deps, getStates: stale }), null)
  assert.ok(!boxes[0].labelSet.has(runLabelFor("6000")))
})

test("a Box that cannot be woken is given back, not left busy", async () => {
  const { config, boxes, deps } = setup(onlyClaude)
  boxes[0].resume = async () => {
    throw new Error("Box is broken")
  }
  assert.equal(await claimWorker(config, ["agent:claude"], "7000", deps), null)
  assert.deepEqual(runLabels(boxes[0]), [])
  assert.ok(!boxes[0].labelSet.has(config.factory.busyLabel))
})

test("a label limit refusal is a failed claim, and leaves nothing behind", async () => {
  const { config, boxes, deps } = setup(onlyClaude)
  boxes[0].labelSet.add("x1").add("x2").add("x3") // five labels: the Box is full
  assert.equal(await claimWorker(config, ["agent:claude"], "8000", deps), null)
  assert.deepEqual(runLabels(boxes[0]), [])
})

test("gives up when no worker frees up in time", async () => {
  const { config, boxes, deps } = setup()
  for (const box of boxes) box.labelSet.add(config.factory.busyLabel)
  assert.equal(await claimWorker(config, [], "9000", deps), null)
})

test("release removes busy before the run label and pauses the Box", async () => {
  const { config, boxes, deps } = setup(onlyClaude)
  const claim = await claimWorker(config, [], "9100", deps)
  const order = []
  const remove = boxes[0].labels.remove
  boxes[0].labels.remove = async (l) => (order.push(l), remove(l))
  await releaseWorker(config, claim)
  assert.deepEqual(order, [config.factory.busyLabel, runLabelFor("9100")])
  assert.equal(boxes[0].status, "paused")
  assert.deepEqual(runLabels(boxes[0]), [])
})
