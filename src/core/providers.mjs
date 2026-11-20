// Typed provider errors and a per-provider circuit breaker (docs/architecture/15
// §4, Phase 05 slice 3). Pure: no clock, no I/O; callers pass `now`.
//
// classifyProviderError turns agent output into one typed kind instead of a
// single yes/no regex. The transient kinds match exactly what the old
// TRANSIENT_AGENT regex in ../guards.mjs matched, so the pipeline's one
// fallback to another agent type behaves as before. "auth" is new and is not
// transient: a missing or expired credential does not heal by retrying.

export const PROVIDER_ERROR_KINDS = ["quota", "rate_limit", "overloaded", "network", "auth"]

// Order is precedence: the first kind whose pattern matches wins.
const PATTERNS = [
  ["quota", /usage limit|weekly limit|quota/i, true],
  ["rate_limit", /rate.?limit|too many requests|\b429\b/i, true],
  ["overloaded", /overloaded|at capacity|temporarily unavailable|try again (later|in)|\b(503|529)\b/i, true],
  ["network", /ECONNRESET|ETIMEDOUT|socket hang up/i, true],
  ["auth", /\b401\b|unauthori[sz]ed|invalid (api key|x-api-key|token)|authentication (failed|error)|not logged in|please (log ?in|run \/login)/i, false],
]

// Returns { kind, transient, match } or null when the text shows no provider error.
export function classifyProviderError(text) {
  const s = String(text ?? "")
  for (const [kind, pattern, transient] of PATTERNS) {
    const m = s.match(pattern)
    if (m) return { kind, transient, match: m[0] }
  }
  return null
}

// --- circuit breaker ---------------------------------------------------------
// closed: calls go through. After `threshold` consecutive transient failures it
// opens for `cooldownMs`; then it is half-open: one probe call may go through.
// A success closes it; a failure while half-open opens it again at once.
// Non-provider failures (a failing test, a syntax error) never count.

export const BREAKER_DEFAULTS = { threshold: 3, cooldownMs: 5 * 60 * 1000 }

export function createBreaker(options = {}) {
  const { threshold, cooldownMs } = { ...BREAKER_DEFAULTS, ...options }
  if (!(Number.isInteger(threshold) && threshold > 0)) throw new Error("threshold must be a positive integer")
  if (!(Number.isFinite(cooldownMs) && cooldownMs > 0)) throw new Error("cooldownMs must be a positive number")
  return { threshold, cooldownMs, failures: 0, openedAt: null, lastKind: null }
}

export function breakerState(breaker, now) {
  if (breaker.openedAt === null) return "closed"
  return now - breaker.openedAt >= breaker.cooldownMs ? "half-open" : "open"
}

// The router treats a provider as unavailable while its breaker is open.
export const isAvailable = (breaker, now) => breakerState(breaker, now) !== "open"

export function recordFailure(breaker, error, now) {
  if (!error?.transient) return breaker
  const failures = breaker.failures + 1
  const wasHalfOpen = breakerState(breaker, now) === "half-open"
  const opens = wasHalfOpen || failures >= breaker.threshold
  return { ...breaker, failures, lastKind: error.kind, openedAt: opens ? now : breaker.openedAt }
}

export function recordSuccess(breaker) {
  return { ...breaker, failures: 0, openedAt: null, lastKind: null }
}
