// Frees workers still claimed by factory runs that have finished: the run was
// cancelled, timed out or its runner was lost before any cleanup could run.
// A claim whose run is still queued or running is never touched, and neither
// is one whose run cannot be looked up.
//
// The factory workflow runs this before every job. It needs to read this
// repo's Actions runs: the workflow passes its own GITHUB_TOKEN for that.
//
// By hand: GITHUB_TOKEN=<token with Actions read> node --env-file=.env scripts/reap-stale.mjs
import { Box } from "@upstash/box"
import { loadConfig } from "../src/config.mjs"
import { getIssue, listComments, addLabels, removeLabel, comment, getWorkflowRun } from "../src/github.mjs"
import { reapStale } from "../src/recover.mjs"

const config = loadConfig()
const actionsToken = process.env.GITHUB_TOKEN ?? process.env.FACTORY_GITHUB_TOKEN

try {
  const report = await reapStale(config, {
    listBoxes: () => Box.list({ label: config.factory.boxLabel }),
    getBox: (id) => Box.get(id),
    getRun: (id) => getWorkflowRun(config.factory.repo, id, actionsToken),
    api: { getIssue, listComments, addLabels, removeLabel, comment },
    currentRunId: process.env.GITHUB_RUN_ID,
  })
  console.log(`Recovered ${report.recovered.length}, live ${report.live.length}, could not check ${report.unknown.length}.`)
} catch (error) {
  // A failed sweep must not stop the run it precedes. It is tried again next time.
  console.log(`::warning::Could not check for stale workers: ${error.message}`)
}
