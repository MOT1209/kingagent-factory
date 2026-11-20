import { test } from "node:test"
import assert from "node:assert/strict"
import { createLedger, memoryStore } from "../src/core/slots.mjs"

const main = { type: "main" }
const setup = (start = 1000) => {
  const clock = { t: start }
  let n = 0
  const store = memoryStore()
  const ledger = createLedger(store, { now: () => clock.t, makeToken: () => `tok-${++n}` })
  return { clock, store, ledger }
}
const take = (ledger, id, extra = {}) => ledger.acquire({ actor: main, parentId: "P", taskId: id, leaseMs: 100, ...extra })

test("four slots are granted and the fifth is refused", () => {
  const { ledger } = setup()
  for (const id of ["a", "b", "c", "d"]) assert.equal(take(ledger, id).ok, true, id)
  assert.deepEqual(take(ledger, "e"), { ok: false, reason: "no-free-slot" })
  assert.equal(ledger.active("P"), 4)
})

test("the cap is per parent task", () => {
  const { ledger } = setup()
  for (const id of ["a", "b", "c", "d"]) take(ledger, id)
  assert.equal(ledger.acquire({ actor: main, parentId: "Q", taskId: "a", leaseMs: 100 }).ok, true)
})

test("only the Main Agent may take a slot", () => {
  const { ledger } = setup()
  for (const actor of [{ type: "sub" }, { type: "system" }, { type: "human", role: "operator" }, null]) {
    assert.equal(take(ledger, "a", { actor }).reason, "forbidden", JSON.stringify(actor))
  }
  assert.equal(ledger.active("P"), 0)
})

test("bad input is rejected", () => {
  const { ledger } = setup()
  assert.equal(take(ledger, "a", { leaseMs: 0 }).reason, "invalid")
  assert.equal(take(ledger, "", {}).reason, "invalid")
  assert.equal(take(ledger, "a", { parentId: "" }).reason, "invalid")
})

test("asking again for the same task is idempotent and uses no extra slot", () => {
  const { ledger } = setup()
  const first = take(ledger, "a")
  const again = take(ledger, "a")
  assert.equal(again.token, first.token)
  assert.equal(ledger.active("P"), 1)
})

test("release frees a slot only with the matching token", () => {
  const { ledger } = setup()
  const a = take(ledger, "a")
  for (const id of ["b", "c", "d"]) take(ledger, id)
  assert.equal(ledger.release({ parentId: "P", taskId: "a", token: "wrong" }).reason, "unknown-slot")
  assert.equal(take(ledger, "e").ok, false, "still full")
  assert.equal(ledger.release({ parentId: "P", taskId: "a", token: a.token }).ok, true)
  assert.equal(take(ledger, "e").ok, true)
  assert.equal(ledger.release({ parentId: "P", taskId: "a", token: a.token }).reason, "unknown-slot", "second release does nothing")
})

test("an expired lease frees its slot, so a crashed sub-agent cannot block the parent forever", () => {
  const { clock, ledger } = setup()
  for (const id of ["a", "b", "c", "d"]) take(ledger, id)
  clock.t += 101
  assert.equal(ledger.active("P"), 0)
  assert.equal(take(ledger, "e").ok, true)
})

test("renew extends a live lease but not an expired or foreign one", () => {
  const { clock, ledger } = setup()
  const a = take(ledger, "a")
  clock.t += 60
  assert.equal(ledger.renew({ parentId: "P", taskId: "a", token: a.token, leaseMs: 100 }).ok, true)
  clock.t += 60
  assert.equal(ledger.active("P"), 1, "renewed past the original expiry")
  assert.equal(ledger.renew({ parentId: "P", taskId: "a", token: "wrong", leaseMs: 100 }).ok, false)
  clock.t += 200
  assert.equal(ledger.renew({ parentId: "P", taskId: "a", token: a.token, leaseMs: 100 }).ok, false)
})

test("a lost compare-and-set race is retried, never double-booked", () => {
  const { store, ledger } = setup()
  for (const id of ["a", "b", "c"]) take(ledger, id)
  // Another writer takes the fourth slot between our read and our write.
  const realCas = store.cas
  let raced = false
  store.cas = (key, version, value) => {
    if (!raced) {
      raced = true
      realCas(key, version, { slots: { ...store.get(key).value.slots, d: { token: "other", expiresAt: 5000 } } })
    }
    return realCas(key, version, value)
  }
  const result = take(ledger, "e")
  assert.deepEqual(result, { ok: false, reason: "no-free-slot" })
  assert.equal(ledger.active("P"), 4)
})

test("persistent contention gives up with a reason instead of looping", () => {
  const { store, ledger } = setup()
  store.cas = () => false
  assert.deepEqual(take(ledger, "a"), { ok: false, reason: "contention" })
})
