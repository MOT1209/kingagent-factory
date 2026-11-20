// The append-only event model of docs/architecture/22 §2, as a pure builder plus
// a JSONL writer that never throws (like writeRunRecord in ../report.mjs). No
// store yet: Phase 03 only fixes the shape. Every string is masked first.
import { appendFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

export const EVENT_SCHEMA = 1
export const EVENT_TYPES = ["task.state", "slot.acquire", "slot.release", "model.assign", "model.change", "step.result", "failure.state", "guard.hit", "provider.error", "budget.warn", "budget.stop", "approval.request", "approval.grant", "policy.denial", "security.event"]
const ACTOR_TYPES = ["main", "sub", "human", "system"]

const mask = (value, redact) => {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((v) => mask(v, redact))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, redact)]))
  return value
}

export function makeEvent({ type, taskId = null, runId = null, factory = null, project = null, actor, data = {} }, { redact = (s) => s, now = new Date(), id = randomUUID() } = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type "${type}"`)
  if (!actor || !ACTOR_TYPES.includes(actor.type)) throw new Error("An event needs an actor with a type of main, sub, human or system")
  return { schema: EVENT_SCHEMA, id, ts: now.toISOString(), type, factory, project, taskId, runId: runId === null ? null : String(runId), actor: mask(actor, redact), data: mask(data, redact) }
}

// One JSON object per line. Without a file nothing is written; a write error is
// reported as false, never thrown, so observability cannot fail a run.
export function appendEvent(event, file = process.env.FACTORY_EVENTS, write = appendFileSync) {
  if (!file) return false
  try {
    write(file, JSON.stringify(event) + "\n")
    return true
  } catch {
    return false
  }
}
