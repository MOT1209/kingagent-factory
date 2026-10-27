import { test } from "node:test"
import assert from "node:assert/strict"
import { transitions, applyTransition, labelsAfter, takenByAnotherRun } from "../src/issue-state.mjs"
import { realConfig, fakeGithub } from "./helpers.mjs"

const labels = realConfig().labels
const t = transitions(labels)
const sorted = (xs) => [...xs].sort()

test("claim: ready -> running, and an old needs-attention or review goes", () => {
  assert.deepEqual(sorted(labelsAfter(["ready", "bug", labels.needsAttention, labels.review], t.running)), sorted(["bug", labels.running]))
})

test("success: running -> review", () => {
  assert.deepEqual(sorted(labelsAfter([labels.running, "bug"], t.review)), sorted(["bug", labels.review]))
})

test("failure, timeout or cancel: running -> needs-attention, never ready", () => {
  for (const start of [[labels.running], ["ready"], ["ready", labels.running]]) {
    const end = labelsAfter(start, t.needsAttention)
    assert.deepEqual(end, [labels.needsAttention], start.join(","))
  }
})

test("no outcome leaves two factory states on an issue", () => {
  const states = [labels.ready, labels.running, labels.review, labels.needsAttention]
  for (const transition of Object.values(t)) {
    const end = labelsAfter(states, transition)
    assert.equal(end.filter((l) => states.includes(l)).length, 1)
  }
})

test("applyTransition adds before it removes and reaches the same end state", async () => {
  const gh = fakeGithub(["ready"])
  const calls = []
  const api = { addLabels: async (...a) => (calls.push("add"), gh.addLabels(...a)), removeLabel: async (...a) => (calls.push("remove"), gh.removeLabel(...a)) }
  await applyTransition(api, "o/r", 1, t.running)
  assert.equal(calls[0], "add")
  assert.deepEqual([...gh.issue.labels], [labels.running])
})

test("a running label means another run owns the issue", () => {
  assert.equal(takenByAnotherRun(["ready", labels.running], labels), true)
  assert.equal(takenByAnotherRun(["ready"], labels), false)
})
