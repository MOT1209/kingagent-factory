import { test } from "node:test"
import assert from "node:assert/strict"
import { selectRepos, withRetry, isTransientCliFailure } from "../src/admin.mjs"

const repos = [{ repo: "MOT1209/KingAgent" }, { repo: "MOT1209/rashid-hq-os" }, { repo: "MOT1209/Tarjim" }]

test("without --only every repo is used", () => {
  assert.deepEqual(selectRepos(repos, ["--yes"]), { repos, only: false })
})

test("--only picks the named repos, ignoring case, in config order", () => {
  const picked = selectRepos(repos, ["--yes", "--only", "mot1209/tarjim,MOT1209/KingAgent"])
  assert.deepEqual(picked.repos.map((r) => r.repo), ["MOT1209/KingAgent", "MOT1209/Tarjim"])
  assert.equal(picked.only, true)
})

test("--only=owner/name works too, and may be repeated", () => {
  const picked = selectRepos(repos, ["--only=MOT1209/Tarjim", "--only", "MOT1209/rashid-hq-os"])
  assert.deepEqual(picked.repos.map((r) => r.repo), ["MOT1209/rashid-hq-os", "MOT1209/Tarjim"])
})

test("--only with an unknown repo is an error, never 'all' or 'none'", () => {
  assert.throws(() => selectRepos(repos, ["--only", "MOT1209/Typo"]), /not in factory\.config\.json: MOT1209\/Typo/)
})

test("--only with no value is an error", () => {
  assert.throws(() => selectRepos(repos, ["--only"]), /needs one or more owner\/name/)
  assert.throws(() => selectRepos(repos, ["--only", " , "]), /needs one or more owner\/name/)
})

test("transient failures are told apart from permanent ones", () => {
  assert.equal(isTransientCliFailure('Post "https://api.github.com/graphql": net/http: TLS handshake timeout'), true)
  assert.equal(isTransientCliFailure("fatal: unable to access: Connection reset by peer"), true)
  assert.equal(isTransientCliFailure("HTTP 502: Bad Gateway"), true)
  assert.equal(isTransientCliFailure("HTTP 403: Resource not accessible by personal access token"), false)
  assert.equal(isTransientCliFailure("HTTP 404: Not Found"), false)
})

test("withRetry retries a transient failure and then succeeds", () => {
  let calls = 0
  const waits = []
  const result = withRetry(() => {
    if (++calls < 3) throw new Error("TLS handshake timeout")
    return "ok"
  }, { attempts: 3, delayMs: 10, sleep: (ms) => waits.push(ms) })
  assert.equal(result, "ok")
  assert.equal(calls, 3)
  assert.deepEqual(waits, [10, 20])
})

test("withRetry gives up after the last attempt and rethrows", () => {
  let calls = 0
  assert.throws(() => withRetry(() => { calls++; throw new Error("i/o timeout") }, { attempts: 3, sleep: () => {} }), /i\/o timeout/)
  assert.equal(calls, 3)
})

test("withRetry does not retry a permanent failure", () => {
  let calls = 0
  assert.throws(() => withRetry(() => { calls++; throw new Error("HTTP 403") }, { attempts: 3, sleep: () => {} }), /403/)
  assert.equal(calls, 1)
})
