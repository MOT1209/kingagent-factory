import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyProviderError, createBreaker, breakerState, isAvailable, recordFailure, recordSuccess, PROVIDER_ERROR_KINDS } from "../src/core/providers.mjs"
import { isTransientAgentFailure } from "../src/guards.mjs"

// The regex guards.mjs used before typed errors. Kept here only to prove the
// transient kinds match exactly the same texts.
const OLD_TRANSIENT = /usage limit|weekly limit|rate.?limit|quota|too many requests|overloaded|at capacity|temporarily unavailable|try again (later|in)|\b(429|503|529)\b|ECONNRESET|ETIMEDOUT|socket hang up/i

const SAMPLES = [
  "Claude usage limit reached", "weekly limit hit", "quota exceeded", "Error 429 Too Many Requests", "rate limit", "rate-limit",
  "API overloaded_error: Overloaded", "The service is at capacity", "503 Service Unavailable", "529", "temporarily unavailable",
  "Please try again later", "try again in 5 minutes", "ECONNRESET", "connect ETIMEDOUT", "socket hang up",
  "SyntaxError: unexpected token", "npm test failed: 3 failing", "exit code 3", "4290 tests", "port 5030", "",
  "401 Unauthorized", "Invalid API key", "Please run /login", "not logged in",
]

test("transient kinds match exactly what the old regex matched", () => {
  for (const s of SAMPLES) assert.equal(isTransientAgentFailure(s), OLD_TRANSIENT.test(s), s)
  assert.equal(isTransientAgentFailure(undefined), false)
  assert.equal(isTransientAgentFailure(null), false)
})

test("each provider error gets one typed kind", () => {
  const kind = (s) => classifyProviderError(s)?.kind ?? null
  assert.equal(kind("Claude usage limit reached"), "quota")
  assert.equal(kind("Error 429 Too Many Requests"), "rate_limit")
  assert.equal(kind("API overloaded_error: Overloaded"), "overloaded")
  assert.equal(kind("503 Service Unavailable"), "overloaded")
  assert.equal(kind("read ECONNRESET"), "network")
  assert.equal(kind("401 Unauthorized"), "auth")
  assert.equal(kind("Invalid API key · Please run /login"), "auth")
  assert.equal(kind("npm test failed: 3 failing"), null)
  for (const s of SAMPLES) {
    const e = classifyProviderError(s)
    if (e) assert.ok(PROVIDER_ERROR_KINDS.includes(e.kind) && typeof e.match === "string" && e.match.length > 0, s)
  }
})

test("auth errors are typed but not transient, so they do not trigger the agent fallback", () => {
  assert.deepEqual(classifyProviderError("HTTP 401: authentication failed"), { kind: "auth", transient: false, match: "401" })
  assert.equal(isTransientAgentFailure("401 Unauthorized"), false)
})

test("precedence: a quota message that also says 429 is quota", () => {
  assert.equal(classifyProviderError("429: weekly limit reached").kind, "quota")
})

test("breaker: opens after the threshold of consecutive transient failures", () => {
  const err = classifyProviderError("overloaded")
  let b = createBreaker({ threshold: 3, cooldownMs: 1000 })
  b = recordFailure(b, err, 0)
  b = recordFailure(b, err, 10)
  assert.equal(breakerState(b, 10), "closed")
  b = recordFailure(b, err, 20)
  assert.equal(breakerState(b, 20), "open")
  assert.equal(isAvailable(b, 500), false)
  assert.equal(b.lastKind, "overloaded")
})

test("breaker: half-open after the cooldown; a success closes it, a failure reopens it at once", () => {
  const err = classifyProviderError("ECONNRESET")
  let b = createBreaker({ threshold: 1, cooldownMs: 1000 })
  b = recordFailure(b, err, 0)
  assert.equal(breakerState(b, 999), "open")
  assert.equal(breakerState(b, 1000), "half-open")
  assert.equal(isAvailable(b, 1000), true)
  assert.equal(breakerState(recordSuccess(b), 1000), "closed")
  // The half-open probe fails: open again from now, without waiting for the threshold.
  let wide = createBreaker({ threshold: 3, cooldownMs: 1000 })
  for (const t of [0, 1, 2]) wide = recordFailure(wide, err, t)
  const again = recordFailure(wide, err, 2000)
  assert.equal(breakerState(again, 2000), "open")
  assert.equal(again.openedAt, 2000)
})

test("breaker: task failures and auth errors never count; a success resets the streak", () => {
  let b = createBreaker({ threshold: 2, cooldownMs: 1000 })
  b = recordFailure(b, classifyProviderError("npm test failed"), 0)
  b = recordFailure(b, classifyProviderError("401 Unauthorized"), 0)
  assert.equal(b.failures, 0)
  b = recordFailure(b, classifyProviderError("429"), 0)
  b = recordSuccess(b)
  b = recordFailure(b, classifyProviderError("429"), 1)
  assert.equal(breakerState(b, 1), "closed")
})

test("breaker: is pure and rejects bad options", () => {
  const b = createBreaker()
  const after = recordFailure(b, classifyProviderError("429"), 0)
  assert.equal(b.failures, 0)
  assert.equal(after.failures, 1)
  assert.throws(() => createBreaker({ threshold: 0 }), /threshold/)
  assert.throws(() => createBreaker({ cooldownMs: -1 }), /cooldownMs/)
})
