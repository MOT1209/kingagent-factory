import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { github, transport, hintFor, isTransient, openPullRequest, removeLabel, ownerRun, runMark, getWorkflowRun } from "../src/github.mjs"

// A scripted fetch: each call takes the next answer.
let calls
function answers(...list) {
  calls = []
  transport.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.Authorization })
    const next = list.shift()
    if (next instanceof Error) throw next
    const { status = 200, json = {}, headers = {} } = next
    return { ok: status < 300, status, headers: new Map(Object.entries(headers)), json: async () => json, text: async () => JSON.stringify(json) }
  }
}
beforeEach(() => {
  process.env.FACTORY_GITHUB_TOKEN = "tok"
  transport.sleep = async () => {}
})

test("each failure class gets its own explanation", () => {
  assert.match(hintFor(401), /invalid or expired/)
  assert.match(hintFor(403, "Resource not accessible by personal access token"), /lacks a permission/)
  assert.match(hintFor(403, "API rate limit exceeded"), /rate limit/)
  assert.match(hintFor(404), /cannot see it/)
  assert.match(hintFor(409), /Conflict/)
  assert.match(hintFor(422), /invalid/)
  assert.match(hintFor(502), /server error/)
})

test("only rate limits and server errors are retried", () => {
  assert.ok(isTransient(502))
  assert.ok(isTransient(429))
  assert.ok(isTransient(403, "You have exceeded a secondary rate limit"))
  assert.ok(isTransient(403, "", new Map([["x-ratelimit-remaining", "0"]])))
  assert.ok(!isTransient(403, "Resource not accessible by personal access token"))
  assert.ok(!isTransient(401))
  assert.ok(!isTransient(422))
})

test("a server error is retried and then succeeds", async () => {
  answers({ status: 502 }, { status: 200, json: { ok: 1 } })
  assert.deepEqual(await github("/x"), { ok: 1 })
  assert.equal(calls.length, 2)
})

test("retries stop after three tries", async () => {
  answers({ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 })
  await assert.rejects(github("/x"), (e) => e.status === 503 && /server error/.test(e.message))
  assert.equal(calls.length, 3)
})

test("a missing permission fails at once, with status and advice", async () => {
  answers({ status: 403, json: { message: "Resource not accessible by personal access token" } })
  await assert.rejects(github("/repos/o/r/labels", { method: "POST", body: {} }), (e) => e.status === 403 && /repository selection/.test(e.message))
  assert.equal(calls.length, 1)
})

test("a write that hit a network failure mid-flight is not repeated", async () => {
  answers(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), { status: 201 })
  await assert.rejects(github("/repos/o/r/issues/1/comments", { method: "POST", body: { body: "x" } }), /could not be reached/)
  assert.equal(calls.length, 1, "a comment is never posted twice")
})

test("a GET that hit a network failure is repeated", async () => {
  answers(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), { status: 200, json: [] })
  assert.deepEqual(await github("/x"), [])
})

test("the token override is used for the workflow's own token", async () => {
  answers({ status: 200, json: { status: "completed" } })
  await getWorkflowRun("o/r", 5, "workflow-token")
  assert.equal(calls[0].auth, "Bearer workflow-token")
})

test("a run that cannot be read is null, not an error", async () => {
  answers({ status: 403 })
  assert.equal(await getWorkflowRun("o/r", 5), null)
})

test("an existing pull request for the branch is updated, not duplicated", async () => {
  answers({ status: 200, json: [{ number: 4 }] }, { status: 200, json: { number: 4, html_url: "u" } })
  const pr = await openPullRequest("o/r", { head: "factory/issue-1", base: "main", title: "t", body: "b" })
  assert.equal(pr.number, 4)
  assert.equal(calls[1].method, "PATCH")
  assert.match(calls[0].url, /head=o:factory%2Fissue-1/)
})

test("a new pull request is created when none is open", async () => {
  answers({ status: 200, json: [] }, { status: 201, json: { number: 5 } })
  await openPullRequest("o/r", { head: "h", base: "main", title: "t", body: "b" })
  assert.equal(calls[1].method, "POST")
  assert.deepEqual(calls[1].body, { head: "h", base: "main", title: "t", body: "b" })
})

test("removing a label that is not there is fine, other errors are not", async () => {
  answers({ status: 404 })
  await removeLabel("o/r", 1, "x")
  answers({ status: 403 })
  await assert.rejects(removeLabel("o/r", 1, "x"), (e) => e.status === 403)
})

test("the owning run is the latest factory pickup comment", () => {
  const mark = "<!-- software-factory -->"
  assert.equal(ownerRun([{ body: `a ${runMark(1)} ${mark}` }, { body: `b ${runMark(2)} ${mark}` }]), "2")
  assert.equal(ownerRun([{ body: `a person pasting ${runMark(9)}` }]), null, "a person's comment cannot claim the issue")
  assert.equal(ownerRun([]), null)
})
