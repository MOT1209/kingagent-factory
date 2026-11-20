// The complexity classifier and model resolver of docs/architecture/15 (Phase 05
// slice 1). Pure and deterministic: tiers come from structured facts (paths,
// counts, role), never from the issue text, so an issue cannot talk its way to
// a different model. No model id is hard-coded; a model is assignable only when
// the registry says a probe verified it. Wired into the pipeline in shadow mode
// only (factory.orchestration.enabled): decisions are recorded, never applied.

export const TIERS = ["economical", "balanced", "powerful", "advanced"]
export const MAX_ESCALATIONS_PER_TASK = 2

const SECURITY_PATH = /(^|\/)(auth|secrets?|crypto|\.github\/workflows)(\/|\.|$)|(^|\/)\.env/i
const ARCHITECTURE_PATH = /(^|\/)(schema|migrations?|config|package\.json|factory\.config\.json)(\/|\.|$)|(^|\/)(api|contracts?)\//i
const REASONING_TAGS = ["refactor", "design", "debug-unknown"]

const tierOfScore = (score) => (score <= 2 ? "economical" : score <= 5 ? "balanced" : score <= 9 ? "powerful" : "advanced")

// facts: { paths?: string[] (estimated or actual), tags?: string[], needsBrowser?: boolean,
//          hasAcceptance?: boolean, architectureRedesign?: boolean }
export function classify(task, facts = {}) {
  const paths = Array.isArray(facts.paths) ? facts.paths : []
  const reasons = []
  let score = 0
  const add = (points, why) => { score += points; reasons.push(`+${points} ${why}`) }

  if (paths.length > 10) add(2, `${paths.length} files affected`)
  if (paths.some((p) => ARCHITECTURE_PATH.test(p))) add(3, "touches config, schema or a public contract")
  if (facts.hasAcceptance === false || (task.acceptance ?? []).length === 0) add(2, "no acceptance criteria")
  const deps = Math.min((task.dependencies ?? []).length, 3)
  if (deps) add(deps, `${deps} upstream task(s)`)
  const security = paths.some((p) => SECURITY_PATH.test(p)) || task.role === "security"
  if (security) add(4, "security-sensitive paths")
  if ((facts.tags ?? []).some((t) => REASONING_TAGS.includes(t))) add(2, "needs deep reasoning")
  if (facts.needsBrowser) add(2, "browser or integration testing")

  let tier = tierOfScore(score)
  if (security && TIERS.indexOf(tier) < TIERS.indexOf("powerful")) { tier = "powerful"; reasons.push("floor: security work is at least powerful") }
  if (facts.architectureRedesign) { tier = "advanced"; reasons.push("architecture redesign is advanced") }
  return { tier, score, reasons }
}

// registry.tiers[tier] is an ordered list of entries { provider, model, status }.
// The first verified entry wins; an unverified model is never assigned.
export function resolveModel(registry, tier, { skip = [] } = {}) {
  if (!TIERS.includes(tier)) return { ok: false, reason: `unknown tier "${tier}"` }
  const entries = registry?.tiers?.[tier] ?? []
  const usable = entries.find((e) => e && e.status === "verified" && e.provider && e.model && !skip.includes(`${e.provider}:${e.model}`))
  if (usable) return { ok: true, provider: usable.provider, model: usable.model, tier }
  return { ok: false, reason: entries.length ? `no verified model in tier ${tier}` : `no models registered for tier ${tier}` }
}

// One tier step up, only while the task and parent budget allow it and the
// task has escalated fewer than twice. Otherwise: hand to a human.
export function escalate({ tier, escalations = 0, budgetAllows = false }) {
  if (!budgetAllows) return { ok: false, reason: "budget does not allow escalation", handTo: "human" }
  if (escalations >= MAX_ESCALATIONS_PER_TASK) return { ok: false, reason: "escalation limit reached", handTo: "human" }
  const next = TIERS[TIERS.indexOf(tier) + 1]
  if (!next) return { ok: false, reason: "already at the top tier", handTo: "human" }
  return { ok: true, tier: next, escalations: escalations + 1 }
}
