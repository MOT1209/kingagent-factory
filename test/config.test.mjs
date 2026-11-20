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

test("missing agent secrets are named, never shown", async () => {
  const { missingSecrets } = await import("../src/agents.mjs")
  const config = load()
  const saved = { c: process.env.CLAUDE_CODE_OAUTH_TOKEN, j: process.env.FACTORY_SECRETS_JSON }
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  process.env.FACTORY_SECRETS_JSON = "{}"
  assert.deepEqual(missingSecrets(config, "claude"), ["CLAUDE_CODE_OAUTH_TOKEN"])
  process.env.FACTORY_SECRETS_JSON = JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "from-actions" })
  assert.deepEqual(missingSecrets(config, "claude"), [], "the Actions secrets blob counts")
  if (saved.c !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.c
  if (saved.j === undefined) delete process.env.FACTORY_SECRETS_JSON
  else process.env.FACTORY_SECRETS_JSON = saved.j
})

test("rejects wrong types for workers and repo lists", () => {
  assert.match(loadError((c) => (c.workers[0].enabled = "yes")), /enabled must be true or false/)
  assert.match(loadError((c) => (c.repos = [])), /repos is empty/)
  assert.match(loadError((c) => delete c.repos[0].baseBranch), /needs a baseBranch/)
  assert.match(loadError((c) => c.repos.push({ ...c.repos[0] })), /listed twice/)
})

test("rejects a repo listed twice with different case", () => {
  assert.match(loadError((c) => c.repos.push({ ...c.repos[0], repo: c.repos[0].repo.toLowerCase() })), /listed twice/)
})

test("rejects allowedActors that are not GitHub usernames, or repeat", () => {
  assert.match(loadError((c) => (c.factory.allowedActors = ["*"])), /not a GitHub username/)
  assert.match(loadError((c) => (c.factory.allowedActors = ["a/b"])), /not a GitHub username/)
  assert.match(loadError((c) => (c.factory.allowedActors = ["Bob", "bob"])), /twice/)
})

test("rejects unsafe base branches and malformed command lists", () => {
  assert.match(loadError((c) => (c.repos[0].baseBranch = "--upload-pack=evil")), /not a plain branch name/)
  assert.match(loadError((c) => (c.repos[0].baseBranch = "a..b")), /not a plain branch name/)
  assert.match(loadError((c) => (c.repos[0].checks = "npm test")), /list of non-empty strings/)
  assert.match(loadError((c) => (c.repos[0].setup = [""])), /list of non-empty strings/)
})

test("rejects more workers than the Box limit", () => {
  assert.match(loadError((c) => (c.factory.boxLimit = 1)), /boxLimit/)
})

test("orchestration is optional, and a well-formed one loads", () => {
  load((c) => delete c.factory.orchestration)
  load((c) => (c.factory.orchestration = { enabled: true, registry: { tiers: { economical: [{ provider: "anthropic", model: "m", status: "verified" }] } } }))
})

test("rejects a malformed orchestration block, including unknown keys", () => {
  for (const value of [null, [], "on"]) assert.match(loadError((c) => (c.factory.orchestration = value)), /factory.orchestration must be an object/)
  assert.match(loadError((c) => (c.factory.orchestration = { enabled: "yes" })), /enabled must be true or false/)
  assert.match(loadError((c) => (c.factory.orchestration = { enable: true })), /orchestration.enable is not a known setting/)
  assert.match(loadError((c) => (c.factory.orchestration = { registry: [] })), /registry must be an object with a tiers object/)
  assert.match(loadError((c) => (c.factory.orchestration = { registry: { tiers: { cheap: [] } } })), /tiers.cheap is not a tier/)
  assert.match(loadError((c) => (c.factory.orchestration = { registry: { tiers: { balanced: [{ provider: "x" }] } } })), /tiers.balanced must be a list/)
})
