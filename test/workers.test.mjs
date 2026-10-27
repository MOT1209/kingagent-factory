import { test } from "node:test"
import assert from "node:assert/strict"
import { pickWorker } from "../src/workers.mjs"

const w = (id, agent, state = "free") => ({ id, agent, state })

test("returns null when nobody is free", () => {
  assert.equal(pickWorker([w("a", "claude", "busy"), w("b", "opencode", "disabled")]), null)
})

test("an agent:<name> label forces that agent type", () => {
  const states = [w("claude-01", "claude"), w("opencode-01", "opencode")]
  assert.equal(pickWorker(states, ["ready", "agent:opencode"]).id, "opencode-01")
  assert.equal(pickWorker([w("claude-01", "claude"), w("opencode-01", "opencode", "busy")], ["agent:opencode"]), null)
})

test("higher priority takes unlabelled issues first", () => {
  const states = [w("claude-01", "claude"), w("opencode-01", "opencode")]
  assert.equal(pickWorker(states, [], 0, { opencode: { priority: 5 } }).id, "opencode-01")
})

test("same priority: the type with the smaller busy share goes first", () => {
  const states = [w("claude-01", "claude", "busy"), w("claude-02", "claude"), w("opencode-01", "opencode")]
  assert.equal(pickWorker(states, [], 0, {}).id, "opencode-01")
})

test("disabled workers are never picked and do not count in the pool", () => {
  const states = [w("claude-01", "claude", "disabled"), w("claude-02", "claude"), w("opencode-01", "opencode", "busy")]
  assert.equal(pickWorker(states).id, "claude-02")
})

test("the spread number rotates between equal candidates", () => {
  const states = [w("c-01", "claude"), w("c-02", "claude"), w("c-03", "claude")]
  const picked = new Set([0, 1, 2].map((spread) => pickWorker(states, [], spread).id))
  assert.equal(picked.size, 3)
})
