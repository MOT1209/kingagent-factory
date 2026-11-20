// The slot ledger of docs/architecture/14 (invariant I-1): at most
// MAX_ACTIVE_SUBAGENTS active sub-agents per parent task, enforced here in code
// and never by a prompt. State lives behind a tiny compare-and-set store so a
// real backend can replace the in-memory one without changing the rules.
// Not wired into the pipeline yet (Phase 04 slice 1).
import { randomUUID } from "node:crypto"
import { MAX_ACTIVE_SUBAGENTS, can } from "./policy.mjs"

// Store contract: get(key) -> { value, version } | null;
// cas(key, expectedVersion, value) -> boolean (expectedVersion 0 = "must not exist").
export function memoryStore() {
  const data = new Map()
  return {
    get: (key) => {
      const entry = data.get(key)
      return entry ? { value: structuredClone(entry.value), version: entry.version } : null
    },
    cas: (key, expectedVersion, value) => {
      const current = data.get(key)?.version ?? 0
      if (current !== expectedVersion) return false
      data.set(key, { value: structuredClone(value), version: current + 1 })
      return true
    },
  }
}

const MAX_ATTEMPTS = 8

// Runs mutate(slots) against the stored record until the CAS wins. mutate gets a
// plain { taskId: { token, expiresAt } } map (expired leases already dropped) and
// returns { slots, result }; returning slots === null means "no write needed".
function update(store, parentId, now, mutate) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = store.get(parentId)
    const live = Object.fromEntries(Object.entries(entry?.value.slots ?? {}).filter(([, slot]) => slot.expiresAt > now))
    const { slots, result } = mutate(live)
    if (slots === null) return result
    if (store.cas(parentId, entry?.version ?? 0, { slots })) return result
  }
  return { ok: false, reason: "contention" }
}

export function createLedger(store, { now = () => Date.now(), makeToken = randomUUID } = {}) {
  return {
    // Only an actor with agent.create (the Main Agent) may take a slot. Asking
    // again for the same task returns its existing slot, so retries are safe.
    acquire({ actor, parentId, taskId, leaseMs }) {
      if (!can(actor, "agent.create")) return { ok: false, reason: "forbidden" }
      if (!parentId || !taskId || !(leaseMs > 0)) return { ok: false, reason: "invalid" }
      const at = now()
      return update(store, parentId, at, (slots) => {
        if (slots[taskId]) return { slots: null, result: { ok: true, token: slots[taskId].token, active: Object.keys(slots).length } }
        if (Object.keys(slots).length >= MAX_ACTIVE_SUBAGENTS) return { slots: null, result: { ok: false, reason: "no-free-slot" } }
        const token = makeToken()
        return { slots: { ...slots, [taskId]: { token, expiresAt: at + leaseMs } }, result: { ok: true, token, active: Object.keys(slots).length + 1 } }
      })
    },
    // Needs the capability token that acquire returned, so one sub-agent cannot
    // free another's slot.
    release({ parentId, taskId, token }) {
      const at = now()
      return update(store, parentId, at, (slots) => {
        if (!slots[taskId] || slots[taskId].token !== token) return { slots: null, result: { ok: false, reason: "unknown-slot" } }
        const { [taskId]: _released, ...rest } = slots
        return { slots: rest, result: { ok: true, active: Object.keys(rest).length } }
      })
    },
    // Extends a live lease; an expired or foreign slot cannot be renewed.
    renew({ parentId, taskId, token, leaseMs }) {
      const at = now()
      return update(store, parentId, at, (slots) => {
        if (!slots[taskId] || slots[taskId].token !== token || !(leaseMs > 0)) return { slots: null, result: { ok: false, reason: "unknown-slot" } }
        return { slots: { ...slots, [taskId]: { token, expiresAt: at + leaseMs } }, result: { ok: true } }
      })
    },
    active(parentId) {
      const at = now()
      return Object.values(store.get(parentId)?.value.slots ?? {}).filter((slot) => slot.expiresAt > at).length
    },
  }
}
