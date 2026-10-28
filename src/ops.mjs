// Read-only views for the operator: which worker is doing what, and which claims
// look stale. No writes anywhere. scripts/status.mjs and scripts/doctor.mjs print these.
import { isRunLabel } from "./box.mjs"

// "live": GitHub says the run is queued or running. "finished": it is completed,
// so reap-stale will free the worker. "unknown": cannot be checked (no Actions
// permission, a run started outside Actions). "local" for runs from a laptop.
export async function claimState(label, getRun) {
  const id = /^run-(\d+)$/.exec(label)?.[1]
  if (!id) return { label, state: "local" }
  let run = null
  try {
    run = await getRun(id)
  } catch {
    run = null
  }
  if (!run) return { label, runId: id, state: "unknown" }
  return { label, runId: id, state: run.status === "completed" ? "finished" : "live", conclusion: run.conclusion ?? null, url: run.html_url ?? null }
}

// One row per worker, for a table or for --json.
export async function describeWorkers(states, getRun) {
  const rows = []
  for (const w of states) {
    const claims = []
    for (const label of (w.runs ?? []).filter(isRunLabel)) claims.push(await claimState(label, getRun))
    const stale = claims.filter((c) => c.state === "finished").map((c) => c.label)
    rows.push({ id: w.id, agent: w.agent, state: w.state, box: w.boxStatus, boxId: w.boxId ?? null, claims, stale })
  }
  return rows
}

// What an operator should do, in order. Empty means nothing needs doing.
export function advice(rows) {
  const out = []
  for (const r of rows) {
    if (r.stale.length) out.push(`${r.id}: ${r.stale.join(", ")} finished but still holds it. The next factory run or the scheduled sweep frees it, or run: node --env-file=.env scripts/reap-stale.mjs`)
    if (r.claims.some((c) => c.state === "unknown")) out.push(`${r.id}: a claim cannot be checked (token without Actions read, or a run from outside GitHub). If it is dead: node --env-file=.env scripts/release-worker.mjs ${r.id}`)
    if (r.state === "busy" && r.claims.length === 0) out.push(`${r.id}: busy without any run label (a maintenance script, or one that died). Free it with scripts/release-worker.mjs ${r.id} once you are sure.`)
  }
  return out
}
