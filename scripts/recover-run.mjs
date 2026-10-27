// Cleans up after a factory run that was cancelled or timed out: removes the
// sign-in files from the Box it held, frees the worker, and moves the issue from
// running to needs-attention. The factory workflow runs this automatically when
// its main step does not succeed. It only touches what carries the run's label.
//
// By hand: node --env-file=.env scripts/recover-run.mjs <run id> [owner/repo issue]
import { Box } from "@upstash/box"
import { loadConfig, findRepo } from "../src/config.mjs"
import { getIssue, listComments, addLabels, removeLabel, comment } from "../src/github.mjs"
import { recoverRun } from "../src/recover.mjs"

const [runId = process.env.GITHUB_RUN_ID, repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
if (!runId) throw new Error("Usage: recover-run.mjs <run id> [owner/repo issue]")

const config = loadConfig()
const repo = repoName && findRepo(config, repoName)
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null

try {
  await recoverRun(config, runId, {
    listBoxes: () => Box.list({ label: config.factory.boxLabel }),
    getBox: (id) => Box.get(id),
    api: { getIssue, listComments, addLabels, removeLabel, comment },
    issue: repo && issueNumber ? { repo: repo.repo, number: issueNumber } : null,
    runUrl,
  })
} catch (error) {
  console.error(`Recovery failed: ${error.message}`)
  process.exitCode = 1
}
