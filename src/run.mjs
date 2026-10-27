// Takes one ready issue from start to pull request. The work itself is in
// src/pipeline.mjs.
//
// Run with: node --env-file=.env src/run.mjs owner/app-repo 12
import { loadConfig } from "./config.mjs"
import { getIssue, getHumanComments, addLabels, removeLabel, comment, openPullRequest } from "./github.mjs"
import { claimWorker, releaseWorker } from "./box.mjs"
import { secretValues } from "./agents.mjs"
import { makeRedactor } from "./guards.mjs"
import { runIssue } from "./pipeline.mjs"

const [repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
const runId = process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null
// Replaced once the config is loaded, so every secret is masked, not only the GitHub token.
let redact = (text) => String(text).replaceAll(process.env.FACTORY_GITHUB_TOKEN || "<no token>", "***")

try {
  if (!repoName || !issueNumber) throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>")
  const config = loadConfig()
  redact = makeRedactor(secretValues(config))
  const outcome = await runIssue({
    config,
    repoName,
    issueNumber,
    runId,
    runUrl,
    eventName: process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR,
    token: process.env.FACTORY_GITHUB_TOKEN,
    redact,
    api: { getIssue, getHumanComments, addLabels, removeLabel, comment, openPullRequest },
    claimWorker,
    releaseWorker,
  })
  console.log(`\nOutcome: ${outcome}`)
  // An issue handed back to a person, or never started, is not a success.
  if (outcome === "needs-attention" || outcome === "no-worker") process.exitCode = 1
} catch (error) {
  console.error(`\nFactory run failed: ${redact(error.message)}`)
  process.exitCode = 1
}
