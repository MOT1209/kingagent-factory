import { test } from "node:test"
import assert from "node:assert/strict"
import { recoverRun, reapStale, issueFromRunTitle } from "../src/recover.mjs"
import { runLabelFor } from "../src/box.mjs"
import { runMark } from "../src/github.mjs"
import { realConfig, fakeBox, fakeGithub } from "./helpers.mjs"

const config = realConfig()
const issue = { repo: "MOT1209/KingAgent", number: 7 }
const asListed = (box) => ({ id: box.id, name: box.name, status: box.status, labels: [...box.labelSet] })
const held = (runId, extra = []) => fakeBox({ id: `b-${runId}`, name: "kaf-claude-01", status: "running", labels: [config.factory.boxLabel, "agent-claude", config.factory.busyLabel, runLabelFor(runId), ...extra] })
const pickedUpBy = (runId) => ({ author: "MOT1209", body: `Worker picked this up.\n\n${runMark(runId)}\n\n<!-- software-factory -->` })
const quiet = () => {}

test("a cancelled run: secrets removed, worker freed, issue handed to a person", async () => {
  const box = held("555")
  const gh = fakeGithub([config.labels.running], [pickedUpBy("555")])
  const result = await recoverRun(config, "555", { listBoxes: async () => [asListed(box)], getBox: async () => box, api: gh, issue, log: quiet })

  assert.deepEqual(result.released, ["kaf-claude-01"])
  assert.ok(box.commands.some((c) => c.includes("rm -rf") && c.includes("/workspace/home/.factory")), "sign-in files are removed")
  assert.ok(!box.labelSet.has(config.factory.busyLabel))
  assert.ok(!box.labelSet.has(runLabelFor("555")))
  assert.equal(box.status, "paused")
  assert.deepEqual([...gh.issue.labels], [config.labels.needsAttention])
  assert.equal(gh.issue.comments.length, 1)
})

test("running twice changes nothing the second time", async () => {
  const box = held("556")
  const gh = fakeGithub([config.labels.running], [pickedUpBy("556")])
  const deps = { listBoxes: async () => [asListed(box)], getBox: async () => box, api: gh, issue, log: quiet }
  await recoverRun(config, "556", deps)
  const second = await recoverRun(config, "556", deps)
  assert.deepEqual(second, { released: [], issueUpdated: false })
  assert.equal(gh.issue.comments.length, 1)
})

test("a run that already cleaned up: nothing is touched", async () => {
  const gh = fakeGithub([config.labels.review])
  const result = await recoverRun(config, "557", { listBoxes: async () => [{ id: "b", name: "kaf-claude-01", labels: [config.factory.boxLabel] }], getBox: async () => assert.fail("no Box should be opened"), api: gh, issue, log: quiet })
  assert.deepEqual(result, { released: [], issueUpdated: false })
  assert.deepEqual([...gh.issue.labels], [config.labels.review])
})

test("the issue is not touched when a newer run has taken it", async () => {
  const box = held("558")
  const gh = fakeGithub([config.labels.running], [pickedUpBy("558"), pickedUpBy("559")])
  const result = await recoverRun(config, "558", { listBoxes: async () => [asListed(box)], getBox: async () => box, api: gh, issue, log: quiet })
  assert.equal(result.issueUpdated, false)
  assert.deepEqual([...gh.issue.labels], [config.labels.running])
  assert.deepEqual(result.released, ["kaf-claude-01"], "its own Box is still cleaned")
})

test("a Box that changed hands since it was listed is left alone", async () => {
  const box = held("560")
  const listed = asListed(box)
  // The run let go and another run claimed the Box meanwhile.
  box.labelSet.delete(runLabelFor("560"))
  box.labelSet.add(runLabelFor("561"))
  const result = await recoverRun(config, "560", { listBoxes: async () => [listed], getBox: async () => box, api: fakeGithub([]), issue: null, log: quiet })
  assert.deepEqual(result.released, [])
  assert.ok(box.labelSet.has(config.factory.busyLabel), "the new owner keeps busy")
  assert.ok(box.labelSet.has(runLabelFor("561")))
})

test("run titles name the issue", () => {
  assert.deepEqual(issueFromRunTitle("MOT1209/KingAgent #12"), { repo: "MOT1209/KingAgent", number: 12 })
  assert.equal(issueFromRunTitle("something else"), null)
})

test("reaper: recovers only claims whose runs GitHub says are finished", async () => {
  const dead = held("1001")
  const live = fakeBox({ id: "b-live", name: "kaf-opencode-01", status: "running", labels: [config.factory.boxLabel, config.factory.busyLabel, runLabelFor("1002")] })
  const local = fakeBox({ id: "b-local", name: "kaf-claude-02", labels: [config.factory.busyLabel, "run-local123"] })
  const unreadable = fakeBox({ id: "b-x", name: "kaf-claude-03", labels: [config.factory.busyLabel, runLabelFor("1003")] })
  const boxes = [dead, live, local, unreadable]
  const runs = {
    1001: { status: "completed", conclusion: "cancelled", display_title: "MOT1209/KingAgent #7", html_url: "u" },
    1002: { status: "in_progress", display_title: "MOT1209/KingAgent #8" },
  }
  const gh = fakeGithub([config.labels.running], [pickedUpBy("1001")])
  const report = await reapStale(config, { listBoxes: async () => boxes.map(asListed), getBox: async (id) => boxes.find((b) => b.id === id), getRun: async (id) => runs[id] ?? null, api: gh, currentRunId: "2000", log: quiet })

  assert.deepEqual(report.recovered, [runLabelFor("1001")])
  assert.deepEqual(report.live, [runLabelFor("1002")])
  assert.deepEqual(report.unknown.sort(), [runLabelFor("1003"), "run-local123"].sort())
  assert.ok(!dead.labelSet.has(runLabelFor("1001")))
  assert.ok(live.labelSet.has(runLabelFor("1002")) && live.labelSet.has(config.factory.busyLabel), "a live run keeps its worker")
  assert.ok(local.labelSet.has("run-local123"), "a local run is never guessed at")
  assert.ok(unreadable.labelSet.has(runLabelFor("1003")))
  assert.deepEqual([...gh.issue.labels], [config.labels.needsAttention], "the dead run's issue is handed back")
})

test("reaper skips the run it is part of", async () => {
  const mine = held("3000")
  const report = await reapStale(config, { listBoxes: async () => [asListed(mine)], getBox: async () => assert.fail("must not open"), getRun: async () => assert.fail("must not look up"), api: fakeGithub([]), currentRunId: "3000", log: quiet })
  assert.deepEqual(report, { recovered: [], live: [], unknown: [] })
})

test("recovery that cannot clean the Box leaves it claimed and says what to do", async () => {
  const box = held("570")
  const realCommand = box.exec.command
  const logs = []
  // `ls` still finds the last job's work folder after the removal.
  box.exec.command = async (command) => (command.startsWith("( ls -d") ? { status: "completed", result: "/workspace/home/work\n__EXIT__0" } : realCommand(command))
  const gh = fakeGithub([config.labels.running], [pickedUpBy("570")])
  const result = await recoverRun(config, "570", { listBoxes: async () => [asListed(box)], getBox: async () => box, api: gh, issue, log: (m) => logs.push(m) })
  assert.deepEqual(result.released, [])
  assert.ok(box.labelSet.has(runLabelFor("570")) && box.labelSet.has(config.factory.busyLabel), "still claimed")
  assert.match(logs.join("\n"), /stays claimed.*release-worker/)
})

test("recovery also removes the work folder, not just the sign-in files", async () => {
  const box = held("571")
  await recoverRun(config, "571", { listBoxes: async () => [asListed(box)], getBox: async () => box, api: fakeGithub(), issue: null, log: quiet })
  assert.ok(box.commands.some((c) => c.includes("rm -rf") && c.includes("'/workspace/home/work'")))
})
