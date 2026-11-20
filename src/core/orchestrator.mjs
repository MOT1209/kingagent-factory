// The Main Agent's scheduler for sub-tasks (docs/architecture/14): dependency
// aware, and bounded by the slot ledger, so the cap of four is enforced here in
// code. A sub-agent only receives its own task through `execute`; it never sees
// the ledger, so it cannot spawn, delegate or free a slot. Not wired into the
// pipeline yet (Phase 04 slice 2).
import { validateResult, validateTask } from "./contracts.mjs"

const MAIN = { type: "main" }
const failed = (taskId, summary) => ({ schema: 1, taskId, status: "failed", artifacts: [], summary, usage: { minutes: 0 }, evidence: [] })

// subtasks: validated task.v1 objects with parentId = parent.taskId.
// execute(task) -> result.v1 (may throw). Returns { results: {taskId: result}, skipped: [taskId] }.
export async function runSubtasks({ ledger, parent, subtasks, execute, leaseMs, emit = () => {} }) {
  const bad = subtasks.flatMap((t) => {
    const { ok, errors } = validateTask(t)
    return !ok ? [`${t.taskId}: ${errors.join("; ")}`] : t.parentId !== parent.taskId ? [`${t.taskId}: parentId must be ${parent.taskId}`] : []
  })
  if (bad.length) throw new Error(`Invalid sub-tasks: ${bad.join(" | ")}`)

  const results = {}
  const skipped = []
  const running = new Map() // taskId -> promise of taskId
  let pending = [...subtasks]

  const note = (type, task, data = {}) => {
    try { emit({ type, taskId: task.taskId, actor: MAIN, data }) } catch { /* observability only */ }
  }

  const start = (task, token) => {
    note("slot.acquire", task)
    const run = (async () => {
      let result
      try {
        result = await execute(task)
        const { ok, errors } = validateResult(result)
        if (!ok) result = failed(task.taskId, `invalid result: ${errors.join("; ")}`)
        else if (result.taskId !== task.taskId) result = failed(task.taskId, "result is for a different task")
      } catch (error) {
        result = failed(task.taskId, `execution error: ${error.message}`)
      }
      results[task.taskId] = result
      ledger.release({ parentId: parent.taskId, taskId: task.taskId, token })
      note("slot.release", task, { status: result.status })
      running.delete(task.taskId)
    })()
    running.set(task.taskId, run)
  }

  while (pending.length || running.size) {
    // A task whose dependency failed (or never ran) can never start.
    const dead = pending.filter((t) => t.dependencies.some((d) => results[d] && results[d].status !== "ok"))
    for (const t of dead) skipped.push(t.taskId)
    pending = pending.filter((t) => !dead.includes(t))

    for (const task of pending.filter((t) => t.dependencies.every((d) => results[d]?.status === "ok"))) {
      const slot = ledger.acquire({ actor: MAIN, parentId: parent.taskId, taskId: task.taskId, leaseMs })
      if (!slot.ok) break // no free slot (or contention): wait for a running task to finish
      pending = pending.filter((t) => t !== task)
      start(task, slot.token)
    }

    if (running.size) await Promise.race(running.values())
    else if (pending.length) {
      // Nothing running and nothing startable: unknown dependency or a cycle.
      for (const t of pending) skipped.push(t.taskId)
      pending = []
    }
  }
  return { results, skipped }
}
