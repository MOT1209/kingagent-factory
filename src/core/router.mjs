// The complexity classifier and model resolver of docs/architecture/15 (Phase 05
// slice 1). Pure and deterministic: tiers come from structured facts (paths,
// counts, role), never from the issue text, so an issue cannot talk its way to
// a different model. No model id is hard-coded; a model is assignable only when
// the registry says a probe verified it. Wired into the pipeline in shadow mode
// only (factory.orchestration.enabled): decisions are recorded, never applied.

import { can } from "./policy.mjs"
import { validateTask } from "./contracts.mjs"

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

// --- the task-write path for a model (docs/architecture/15 §1) ---------------
// The one place a task's assignedModel/assignedProvider is written. M-1/M-2:
// only the Main Agent or a factory-admin override may write it (403 otherwise).
// M-3: only before execution starts. M-4: every write returns the event to
// append. A model is assignable only if the registry lists it as verified in
// the given tier; budget checks apply to an override too.
const BEFORE_EXECUTION = ["queued", "claimed", "preparing"]

const refuse = (status, error) => ({ ok: false, status, error })

export function assignModel(task, { actor, provider, model, tier, reason, registry, budgetRemaining } = {}) {
  if (!can(actor, "agent.assign_model")) return refuse(403, `${actor?.type ?? "unknown"} actors cannot assign models`)
  if (actor.type === "human" && !(typeof actor.id === "string" && actor.id.trim())) return refuse(403, "an admin override needs the admin's id")
  if (typeof reason !== "string" || !reason.trim()) return refuse(422, "a model assignment needs a reason")
  if (!BEFORE_EXECUTION.includes(task?.status)) return refuse(409, `the model is fixed once the task is ${task?.status ?? "unknown"}`)
  const budget = budgetRemaining
  if (!budget || !Number.isFinite(budget.minutes) || !Number.isInteger(budget.attempts)) return refuse(422, "budgetRemaining { minutes, attempts } is required")
  if (budget.minutes <= 0 || budget.attempts <= 0) return refuse(409, "the task has no budget left")
  if (!TIERS.includes(tier)) return refuse(422, `unknown tier "${tier}"`)
  const entry = (registry?.tiers?.[tier] ?? []).find((e) => e?.provider === provider && e?.model === model)
  if (!entry) return refuse(422, `${provider}:${model} is not registered in tier ${tier}`)
  if (entry.status !== "verified") return refuse(422, `${provider}:${model} is not verified (status ${entry.status})`)

  const from = task.assignedModel ? `${task.provider}:${task.assignedModel}` : null
  const to = `${provider}:${model}`
  const updated = { ...task, provider, assignedModel: model }
  const { ok, errors } = validateTask(updated)
  if (!ok) return refuse(422, `the task would be invalid: ${errors.join("; ")}`)
  const decidedBy = actor.type === "human" ? `user:${actor.id}` : "main-agent"
  const event = {
    type: from ? "model.change" : "model.assign",
    taskId: task.taskId,
    project: task.project,
    actor: actor.type === "human" ? { type: "human", role: actor.role, id: actor.id } : { type: actor.type },
    data: { task: task.taskId, agent: task.assignedAgent, from, to, reason: reason.trim(), tier, decided_by: decidedBy, budget_remaining: { minutes: budget.minutes, attempts: budget.attempts } },
  }
  return { ok: true, task: updated, event }
}
