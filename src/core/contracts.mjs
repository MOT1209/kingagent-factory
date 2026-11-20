// task.v1 and result.v1: the contracts of docs/architecture/04 and 19. Pure
// validation, no I/O. Nothing in the pipeline calls this yet (Phase 03 strangler:
// runIssue stays as it is until parity is shown).

export const TASK_SCHEMA = 1
export const RESULT_SCHEMA = 1

export const ROLES = ["developer", "reviewer", "qa", "analyst", "architect"]
export const COMPLEXITY = ["simple", "medium", "difficult", "highly-complex"]
export const TOOLS = ["shell", "git-readonly", "pwsh", "browser"]
export const TASK_STATES = ["queued", "claimed", "preparing", "running", "verifying", "reviewing", "succeeded", "failed", "needs_input"]
export const RESULT_STATES = ["ok", "needs_input", "failed", "refused"]

const isStr = (v) => typeof v === "string" && v.trim() !== ""
const isPos = (v) => Number.isFinite(v) && v > 0
const strList = (v) => Array.isArray(v) && v.every((x) => isStr(x))

// Returns { ok, errors }. Every problem is listed, as loadConfig does.
export function validateTask(task) {
  const e = []
  if (!task || typeof task !== "object") return { ok: false, errors: ["task must be an object"] }
  if (task.schema !== TASK_SCHEMA) e.push(`schema must be ${TASK_SCHEMA}`)
  for (const key of ["taskId", "factory", "project", "objective", "idempotencyKey"]) if (!isStr(task[key])) e.push(`${key} must be a non-empty string`)
  if (task.parentId !== null && !isStr(task.parentId)) e.push("parentId must be null or a task id")
  if (typeof task.description !== "string") e.push("description must be a string")
  if (!ROLES.includes(task.role)) e.push(`role must be one of ${ROLES.join(", ")}`)
  if (task.complexity !== null && !COMPLEXITY.includes(task.complexity)) e.push(`complexity must be null or one of ${COMPLEXITY.join(", ")}`)
  // Assignment fields are null until the Main Agent (or an admin) sets them.
  for (const key of ["assignedAgent", "assignedModel", "provider"]) if (task[key] !== null && !isStr(task[key])) e.push(`${key} must be null or a non-empty string`)
  if (!strList(task.dependencies)) e.push("dependencies must be a list of task ids")
  if (!Array.isArray(task.authorizedTools) || task.authorizedTools.some((t) => !TOOLS.includes(t))) e.push(`authorizedTools must be a list from ${TOOLS.join(", ")}`)
  if (!task.budget || !isPos(task.budget.minutes) || !Number.isInteger(task.budget.attempts) || task.budget.attempts < 1) e.push("budget needs minutes > 0 and attempts >= 1")
  if (!isPos(task.timeLimitMinutes)) e.push("timeLimitMinutes must be a positive number")
  if (!strList(task.acceptance)) e.push("acceptance must be a list of strings")
  if (!strList(task.requiredTests)) e.push("requiredTests must be a list of strings")
  if (!TASK_STATES.includes(task.status)) e.push(`status must be one of ${TASK_STATES.join(", ")}`)
  if (Array.isArray(task.dependencies) && task.dependencies.includes(task.taskId)) e.push("a task cannot depend on itself")
  return { ok: e.length === 0, errors: e }
}

// "verified" is a claim that needs recorded evidence: a command and its exit
// code. Agent prose is never evidence (docs 17, 18).
export function validateResult(result) {
  const e = []
  if (!result || typeof result !== "object") return { ok: false, errors: ["result must be an object"] }
  if (result.schema !== RESULT_SCHEMA) e.push(`schema must be ${RESULT_SCHEMA}`)
  if (!isStr(result.taskId)) e.push("taskId must be a non-empty string")
  if (!RESULT_STATES.includes(result.status)) e.push(`status must be one of ${RESULT_STATES.join(", ")}`)
  if (!Array.isArray(result.artifacts)) e.push("artifacts must be a list")
  if (typeof result.summary !== "string") e.push("summary must be a string")
  if (!result.usage || !Number.isFinite(result.usage.minutes) || result.usage.minutes < 0) e.push("usage.minutes must be a number >= 0")
  const evidence = Array.isArray(result.evidence) ? result.evidence : null
  if (!evidence) e.push("evidence must be a list")
  else if (evidence.some((x) => !isStr(x?.command) || !Number.isInteger(x?.exit))) e.push("each evidence entry needs a command and an integer exit code")
  if (result.verified === true && (!evidence || evidence.length === 0)) e.push("verified: true needs at least one evidence entry")
  if (result.verified === true && evidence?.some((x) => x.exit !== 0)) e.push("verified: true cannot carry a non-zero exit code")
  return { ok: e.length === 0, errors: e }
}
