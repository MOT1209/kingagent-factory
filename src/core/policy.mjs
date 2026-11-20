// Who may do what to agents, models and policy (docs 14 and 15). Deterministic
// and testable; a prompt is never the enforcement point. Not wired into the
// pipeline yet.
//
// An actor is { type: "main" | "sub" | "human" | "system", role?: string }.

export const MAX_ACTIVE_SUBAGENTS = 4

const CAPABILITIES = {
  main: ["agent.create", "agent.assign_model", "agent.stop", "task.report"],
  sub: ["task.report"],
  system: ["task.report"],
}
// Humans act through roles. Only a factory admin may override a model.
const HUMAN_ROLES = { "factory-admin": ["agent.assign_model", "agent.stop"], operator: [] }

export function capabilitiesOf(actor) {
  if (!actor || typeof actor !== "object") return []
  if (actor.type === "human") return HUMAN_ROLES[actor.role] ?? []
  return CAPABILITIES[actor.type] ?? []
}

export const can = (actor, capability) => capabilitiesOf(actor).includes(capability)

// Sub-agents never create or assign anything; the limit is checked by the slot
// ledger (Phase 04), this only answers the invariant I-1 for a given count.
export const hasFreeSlot = (activeSubagents) => Number.isInteger(activeSubagents) && activeSubagents >= 0 && activeSubagents < MAX_ACTIVE_SUBAGENTS

// A model change needs the capability AND a reason (invariant M-4).
export function checkModelAssignment(actor, { reason } = {}) {
  if (!can(actor, "agent.assign_model")) return { ok: false, error: `${actor?.type ?? "unknown"} actors cannot assign models` }
  if (typeof reason !== "string" || !reason.trim()) return { ok: false, error: "a model assignment needs a reason" }
  return { ok: true }
}
