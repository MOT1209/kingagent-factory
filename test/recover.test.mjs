import { test } from "node:test"
import assert from "node:assert/strict"
import { recoverRun } from "../src/recover.mjs"
import { runLabelFor } from "../src/box.mjs"
import { realConfig, fakeBox, fakeGithub } from "./helpers.mjs"

const config = realConfig()
const issue = { repo: "MOT1209/KingAgent", number: 7 }

test("a cancelled run: secrets removed, worker freed, issue handed to a person", async () => {
  const box = fakeBox({ id: "b1", name: "kaf-claude-01", status: "running", labels: [config.factory.boxLabel, "agent-claude", config.factory.busyLabel, runLabelFor("555")] })
  const gh = fakeGithub([config.labels.running])
  const result = await recoverRun(config, "555", { listBoxes: async () => [{ id: box.id, name: box.name, status: box.status, labels: [...box.labelSet] }], getBox: async () => box, api: gh, issue, log: () => {} })

  assert.deepEqual(result.released, ["kaf-claude-01"])
  assert.ok(box.commands.some((c) => c.includes("rm -rf") && c.includes("/workspace/home/.factory")), "sign-in files are removed")
  assert.ok(!box.labelSet.has(config.factory.busyLabel))
  assert.ok(!box.labelSet.has(runLabelFor("555")))
  assert.equal(box.status, "paused")
  assert.deepEqual([...gh.issue.labels], [config.labels.needsAttention])
  assert.equal(gh.issue.comments.length, 1)
})

test("a run that already cleaned up: nothing is touched", async () => {
  const gh = fakeGithub([config.labels.review])
  const result = await recoverRun(config, "556", { listBoxes: async () => [{ id: "b", name: "kaf-claude-01", labels: [config.factory.boxLabel] }], getBox: async () => assert.fail("no Box should be opened"), api: gh, issue, log: () => {} })
  assert.deepEqual(result, { released: [], issueUpdated: false })
  assert.deepEqual([...gh.issue.labels], [config.labels.review])
})

test("another run's claim on the same Box keeps the busy label", async () => {
  const box = fakeBox({ id: "b1", name: "kaf-claude-01", labels: [config.factory.busyLabel, runLabelFor("557"), "run-1"] })
  await recoverRun(config, "557", { listBoxes: async () => [{ id: box.id, name: box.name, status: "paused", labels: [...box.labelSet] }], getBox: async () => box, api: fakeGithub([]), issue: null, log: () => {} })
  assert.ok(box.labelSet.has(config.factory.busyLabel))
  assert.ok(!box.labelSet.has(runLabelFor("557")))
})
