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

// --- ambiguous writes, backoff, redaction (hardening) ---
import { retryDelayMs, scrub, addLabels, REQUEST_TIMEOUT_MS } from "../src/github.mjs"

test("a POST that got a 5xx is NOT repeated: GitHub may have applied it", async () => {
  answers({ status: 502 }, { status: 201 })
  await assert.rejects(github("/repos/o/r/issues/1/comments", { method: "POST", body: { body: "x" } }), (e) => e.status === 502)
  assert.equal(calls.length, 1, "a comment is never posted twice")
})

test("a POST that was refused for a rate limit IS repeated: nothing was applied", async () => {
  answers({ status: 429, headers: { "retry-after": "1" } }, { status: 201, json: { id: 1 } })
  assert.deepEqual(await github("/repos/o/r/issues/1/comments", { method: "POST", body: {} }), { id: 1 })
  assert.equal(calls.length, 2)
})

test("PATCH, DELETE and idempotent POSTs (labels) are repeated after a 5xx", async () => {
  answers({ status: 503 }, { status: 200, json: { n: 1 } })
  await github("/x", { method: "PATCH", body: {} })
  assert.equal(calls.length, 2)
  answers({ status: 503 }, { status: 200, json: [] })
  await addLabels("o/r", 1, ["a"])
  assert.equal(calls.length, 2)
})

test("a write that timed out is not repeated and says so", async () => {
  answers(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), { status: 201 })
  await assert.rejects(github("/repos/o/r/issues/1/comments", { method: "POST", body: {} }), /timed out/)
  assert.equal(calls.length, 1)
})

test("every request carries a timeout signal", async () => {
  let seen
  transport.fetch = async (_url, init) => ((seen = init.signal), { ok: true, status: 200, headers: new Map(), json: async () => ({}) })
  await github("/x")
  assert.ok(seen instanceof AbortSignal)
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 60_000)
})

test("backoff: Retry-After seconds, Retry-After date, rate-limit reset, exponential, capped, jittered", () => {
  const now = 1_000_000
  assert.equal(retryDelayMs(1, new Map([["retry-after", "7"]]), now, 0), 7000)
  assert.equal(retryDelayMs(1, new Map([["retry-after", new Date(now + 9000).toUTCString()]]), Math.floor(now / 1000) * 1000, 0) >= 8000, true)
  assert.equal(retryDelayMs(1, new Map([["x-ratelimit-remaining", "0"], ["x-ratelimit-reset", String((now + 5000) / 1000)]]), now, 0), 5000)
  assert.equal(retryDelayMs(1, new Map(), now, 0), 2000)
  assert.equal(retryDelayMs(2, new Map(), now, 0), 4000)
  assert.equal(retryDelayMs(1, new Map([["retry-after", "3600"]]), now, 0), 60_000, "never waits more than a minute")
  assert.notEqual(retryDelayMs(1, new Map(), now, 0), retryDelayMs(1, new Map(), now, 0.9), "jitter spreads the retries")
})

test("tokens never appear in error messages", async () => {
  const token = "ghp_" + "a".repeat(36)
  answers({ status: 500, json: { message: `proxy echoed ${token} and github_pat_${"B".repeat(30)}` } })
  await assert.rejects(github("/x", { method: "PUT", token: "other-token-value" }), (e) => !e.message.includes(token) && !e.message.includes("github_pat_BBB"))
  assert.equal(scrub("Bearer my-secret-token-value", "my-secret-token-value"), "Bearer ***")
})

test("a pull request for the same branch but another base is not silently reused", async () => {
  answers({ status: 200, json: [{ number: 4, base: { ref: "develop" }, head: { ref: "factory/issue-1", repo: { full_name: "o/r" } } }] })
  await assert.rejects(openPullRequest("o/r", { head: "factory/issue-1", base: "main", title: "t", body: "b" }), /targets develop, not main/)
  assert.equal(calls.length, 1, "no PATCH was sent")
})

test("a pull request from a fork's branch of the same name is not reused", async () => {
  answers({ status: 200, json: [{ number: 4, base: { ref: "main" }, head: { ref: "factory/issue-1", repo: { full_name: "stranger/r" } } }] }, { status: 201, json: { number: 9 } })
  const pr = await openPullRequest("o/r", { head: "factory/issue-1", base: "main", title: "t", body: "b" })
  assert.equal(pr.number, 9)
  assert.equal(calls[1].method, "POST")
})

test("a 422 on create because the pull request appeared meanwhile reuses it", async () => {
  const mine = { number: 6, base: { ref: "main" }, head: { ref: "h", repo: { full_name: "o/r" } } }
  answers({ status: 200, json: [] }, { status: 422, json: { message: "A pull request already exists" } }, { status: 200, json: [mine] }, { status: 200, json: { number: 6 } })
  const pr = await openPullRequest("o/r", { head: "h", base: "main", title: "t", body: "b" })
  assert.equal(pr.number, 6)
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "GET", "PATCH"])
})

test("a 422 that is not a race still fails", async () => {
  answers({ status: 200, json: [] }, { status: 422, json: { message: "No commits between main and h" } }, { status: 200, json: [] })
  await assert.rejects(openPullRequest("o/r", { head: "h", base: "main", title: "t", body: "b" }), (e) => e.status === 422)
})
