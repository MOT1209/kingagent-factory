import { test } from "node:test"
import assert from "node:assert/strict"
import { load, loadError } from "./helpers.mjs"

test("the committed factory.config.json loads", () => {
  const config = load()
  assert.equal(config.workers.filter((w) => w.enabled).length, 2)
})

test("rejects a busy label that looks like a run label", () => {
  assert.match(loadError((c) => (c.factory.busyLabel = "run-busy")), /must not start with "run-"/)
})

test("rejects a busy label equal to the Box label", () => {
  assert.match(loadError((c) => (c.factory.busyLabel = c.factory.boxLabel)), /must differ/)
})

test("rejects unsafe branch prefixes", () => {
  for (const prefix of ["", "../x", "a..b/", "x y", "/abs", "a//b"]) {
    assert.match(loadError((c) => (c.factory.branchPrefix = prefix)), /branchPrefix/, prefix)
  }
})

test("rejects non-positive timeouts", () => {
  assert.match(loadError((c) => (c.factory.agentTimeoutMinutes = 0)), /agentTimeoutMinutes must be a positive number/)
  assert.match(loadError((c) => (c.factory.waitForWorkerMinutes = "20")), /waitForWorkerMinutes/)
})

test("rejects duplicate or missing issue labels", () => {
  assert.match(loadError((c) => (c.labels.review = c.labels.running)), /must all be different/)
  assert.match(loadError((c) => delete c.labels.needsAttention), /labels.needsAttention/)
})

test("rejects a worker of an unknown agent type and duplicate workers", () => {
  assert.match(loadError((c) => c.workers.push({ id: "x-01", agent: "nope" })), /unknown agent "nope"/)
  assert.match(loadError((c) => c.workers.push({ ...c.workers[0] })), /listed twice/)
})

test("rejects a config where no worker is enabled", () => {
  assert.match(loadError((c) => c.workers.forEach((w) => (w.enabled = false))), /no worker is enabled/)
})

test("rejects placeholders left from the template", () => {
  assert.match(loadError((c) => (c.factory.repo = "OWNER/factory")), /factory.repo/)
  assert.match(loadError((c) => (c.factory.allowedActors = ["OWNER"])), /allowedActors/)
  assert.match(loadError((c) => (c.repos[0].repo = "OWNER/app")), /real owner\/name/)
})

test("rejects an agent command without {prompt}", () => {
  assert.match(loadError((c) => (c.agents.claude.command = "claude -p hi")), /\{prompt\}/)
})

test("collects every problem in one message", () => {
  const message = loadError((c) => {
    c.factory.busyLabel = "run-x"
    c.factory.agentTimeoutMinutes = -1
  })
  assert.match(message, /run-/)
  assert.match(message, /agentTimeoutMinutes/)
})
