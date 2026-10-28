// Cleans up after factory runs that ended without their own cleanup: a
// cancelled workflow, the workflow's timeout, a lost runner.
//
// recoverRun  cleans up after ONE run, by its id. The workflow calls it when
//             its work step did not succeed.
// reapStale   finds Boxes still claimed by runs that GitHub says are finished
//             and recovers each of them. The workflow calls it before every run.
//
// Both only touch what carries a run's own label, and leave alone anything
// owned by a run that may still be alive. Running them twice changes nothing.
import { runLabelFor, isRunLabel } from "./box.mjs"
import { scrubBox } from "./agents.mjs"
import { ownerRun } from "./github.mjs"
import { transitions, applyTransition } from "./issue-state.mjs"

// Cleans a claimed Box and frees it, in the order that keeps it safe: sign-in
// and work files first (checked), then `busy`, then the given run labels. A Box
// that still holds the last job's files is NOT freed, so nobody else can claim
// it. `labels` are the run labels to remove at the end.
export async function cleanAndFree(config, box, { paused = false, labels }) {
  if (paused) await box.resume()
  const left = await scrubBox(box, config)
  if (left.length) return { freed: false, left }
  await box.labels.remove(config.factory.busyLabel)
  await box.pause().catch(() => {})
  for (const label of labels) await box.labels.remove(label)
  return { freed: true, left: [] }
}

export async function recoverRun(config, runId, { listBoxes, getBox, api, issue, runUrl, log = console.log }) {
  const runLabel = runLabelFor(runId)
  const held = (await listBoxes()).filter((b) => (b.labels ?? []).includes(runLabel))
  if (held.length === 0) {
    log(`No Box carries ${runLabel}. The run released its worker itself, or never claimed one.`)
    return { released: [], issueUpdated: false }
  }

  const released = []
  for (const data of held) {
    const box = await getBox(data.id)
    try {
      // The list can be seconds old. If the run let go meanwhile, the Box may
      // already belong to another run.
      if (!(await box.labels.list()).includes(runLabel)) {
        log(`${data.name ?? data.id} no longer carries ${runLabel}. Left alone.`)
        continue
      }
      // The removal is checked: a Box that still holds the last job's files
      // keeps its labels, so nobody else can claim it.
      const { freed, left } = await cleanAndFree(config, box, { paused: data.status === "paused", labels: [runLabel] })
      if (!freed) {
        log(`Could not clean ${data.name ?? data.id}: ${left.join(", ")}. It stays claimed. Clean it by hand, then free it with scripts/release-worker.mjs.`)
        continue
      }
      released.push(data.name ?? data.id)
      log(`Cleaned and released ${data.name ?? data.id}.`)
    } catch (error) {
      log(`Could not fully release ${data.name ?? data.id}: ${error.message}. Run scripts/release-worker.mjs for it.`)
    }
  }

  // The run held a worker, so the issue may still be in its hands. It is only
  // handed back when the latest "picked this up" comment names this run (or no
  // run at all): a newer run's issue is never touched.
  let issueUpdated = false
  if (issue) {
    const labels = (await api.getIssue(issue.repo, issue.number)).labels.map((l) => l.name)
    const owner = ownerRun(await api.listComments(issue.repo, issue.number))
    if (labels.includes(config.labels.running) && (owner === null || owner === String(runId))) {
      await applyTransition(api, issue.repo, issue.number, transitions(config.labels).needsAttention)
      await api.comment(issue.repo, issue.number, `The factory run was stopped before it finished (cancelled, timed out or lost). Its worker was cleaned up and released. Add \`${config.labels.ready}\` again to retry.${runUrl ? `\n\n[Factory run](${runUrl})` : ""}`)
      issueUpdated = true
      log(`Issue ${issue.repo}#${issue.number} labelled ${config.labels.needsAttention}.`)
    } else if (labels.includes(config.labels.running)) {
      log(`Issue ${issue.repo}#${issue.number} now belongs to run ${owner}. Left alone.`)
    }
  }
  return { released, issueUpdated }
}

// The workflow's run name is "<owner/repo> #<issue>" (factory.yml run-name).
export const issueFromRunTitle = (title) => {
  const match = /^(\S+\/\S+) #(\d+)$/.exec(String(title ?? "").trim())
  return match ? { repo: match[1], number: Number(match[2]) } : null
}

export async function reapStale(config, { listBoxes, getBox, getRun, api, currentRunId, log = console.log }) {
  const boxes = await listBoxes()
  const claims = [...new Set(boxes.flatMap((b) => (b.labels ?? []).filter(isRunLabel)))]
  const report = { recovered: [], live: [], unknown: [] }

  for (const label of claims) {
    const id = /^run-(\d+)$/.exec(label)?.[1]
    if (!id) {
      // A run started from someone's machine. Only its owner knows if it is alive.
      log(`${label}: not a GitHub Actions run, so it cannot be checked. If it is dead, free it with scripts/release-worker.mjs.`)
      report.unknown.push(label)
      continue
    }
    if (id === String(currentRunId)) continue
    const run = await getRun(id)
    if (!run) {
      log(`${label}: the run could not be read (no Actions permission?). Left alone.`)
      report.unknown.push(label)
      continue
    }
    if (run.status !== "completed") {
      report.live.push(label)
      continue
    }
    log(`${label}: run ${id} finished (${run.conclusion}) but still holds a worker. Recovering it.`)
    await recoverRun(config, id, { listBoxes: async () => boxes, getBox, api, issue: issueFromRunTitle(run.display_title), runUrl: run.html_url, log })
    report.recovered.push(label)
  }

  // `busy` without any run label is what the maintenance scripts (build-snapshot,
  // apply-box-settings) set while they work. Nothing here can tell whether one
  // is still running, so it is reported, never cleared.
  for (const b of boxes.filter((b) => (b.labels ?? []).includes(config.factory.busyLabel) && !(b.labels ?? []).some(isRunLabel))) {
    log(`${b.name}: busy without a run label (a maintenance script, or one that died). Free it with scripts/release-worker.mjs once you are sure.`)
  }
  return report
}
