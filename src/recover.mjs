// Cleans up after a factory run that was killed before its own cleanup ran: a
// cancelled workflow, the workflow's timeout, a lost runner. The workflow calls
// it from a step that runs only when the main step did not succeed.
//
// It touches only what carries this run's label, so it is safe to run for a
// run that already cleaned up after itself, or that never claimed a worker.
import { q, sh, runLabelFor } from "./box.mjs"
import { secretPaths } from "./agents.mjs"
import { transitions, applyTransition } from "./issue-state.mjs"

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
      if (data.status === "paused") await box.resume()
      // Secrets first, then the labels, so no new run can claim a Box that
      // still holds the last run's sign-in files.
      await sh(box, `rm -rf ${secretPaths(config).map(q).join(" ")} ~/.git-credentials`, { allowFailure: true })
      await box.labels.remove(runLabel)
      const others = (await box.labels.list()).filter((l) => l.startsWith("run-"))
      if (others.length === 0) await box.labels.remove(config.factory.busyLabel)
      await box.pause().catch(() => {})
      released.push(data.name ?? data.id)
      log(`Cleaned and released ${data.name ?? data.id}.`)
    } catch (error) {
      log(`Could not fully release ${data.name ?? data.id}: ${error.message}. Run scripts/release-worker.mjs for it.`)
    }
  }

  // The run owned a worker, so the issue was in its hands. If it still says
  // running, nobody will move it on, so hand it to a person.
  let issueUpdated = false
  if (issue) {
    const labels = (await api.getIssue(issue.repo, issue.number)).labels.map((l) => l.name)
    if (labels.includes(config.labels.running)) {
      await applyTransition(api, issue.repo, issue.number, transitions(config.labels).needsAttention)
      await api.comment(issue.repo, issue.number, `The factory run was stopped before it finished (cancelled or timed out). Its worker was cleaned up and released. Add \`${config.labels.ready}\` again to retry.${runUrl ? `\n\n[Factory run](${runUrl})` : ""}`)
      issueUpdated = true
      log(`Issue ${issue.repo}#${issue.number} labelled ${config.labels.needsAttention}.`)
    }
  }
  return { released, issueUpdated }
}
