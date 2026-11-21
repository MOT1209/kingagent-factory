// Keeps the per-provider circuit breakers (providers.mjs) between runs. Each run
// is its own Actions job, so the state lives in a small JSON file that the
// workflow carries from run to run with actions/cache (factory.yml). A missing
// or damaged file means every breaker starts closed: the breaker is advice for
// picking a worker, never a reason to stop a run.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createBreaker } from "./providers.mjs"

const isBreaker = (b) =>
  b !== null && typeof b === "object" && Number.isInteger(b.threshold) && b.threshold > 0 && Number.isFinite(b.cooldownMs) && b.cooldownMs > 0 &&
  Number.isInteger(b.failures) && b.failures >= 0 && (b.openedAt === null || Number.isFinite(b.openedAt))

// { <agent type>: breaker }. Unknown or malformed entries are dropped.
export function parseBreakers(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([agent, b]) => /^[a-z0-9-]{1,14}$/.test(agent) && isBreaker(b)).map(([agent, b]) => [agent, { threshold: b.threshold, cooldownMs: b.cooldownMs, failures: b.failures, openedAt: b.openedAt, lastKind: typeof b.lastKind === "string" ? b.lastKind : null }]))
}

export const loadBreakers = (file) => (file && existsSync(file) ? parseBreakers(readFileSync(file, "utf8")) : {})

export function saveBreakers(file, breakers) {
  if (file) writeFileSync(file, `${JSON.stringify(breakers, null, 2)}\n`)
}

export const breakerFor = (breakers, agent) => breakers[agent] ?? createBreaker()
