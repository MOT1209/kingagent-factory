// Takes one ready issue from start to pull request. The work itself is in
// src/pipeline.mjs.
//
// Run with: node --env-file=.env src/run.mjs owner/app-repo 12
import { loadConfig, findRepo } from "./config.mjs"
import { getIssue, getHumanComments, listComments, addLabels, removeLabel, comment, openPullRequest } from "./github.mjs"
import { claimWorker, releaseWorker } from "./box.mjs"
import { secretValues } from "./agents.mjs"
import { makeRedactor } from "./guards.mjs"
import { runIssue } from "./pipeline.mjs"
import { makeEvent, appendEvent } from "./core/events.mjs"
import { summaryMarkdown, statsRecord, runRecord, writeRunRecord, writeJobSummary } from "./report.mjs"

const [repoName = process.env.FACTORY_REPO, issueNumber = process.env.FACTORY_ISSUE] = process.argv.slice(2)
const runId = process.env.GITHUB_RUN_ID ?? `local${Date.now().toString().slice(-9)}`
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null
// Replaced once the config is loaded, so every secret is masked, not only the GitHub token.
const findRepoName = (config, name) => findRepo(config, name)?.repo ?? String(name)
let redact = (text) => String(text).replaceAll(process.env.FACTORY_GITHUB_TOKEN || "<no token>", "***")

try {
  if (!repoName || !issueNumber) throw new Error("Usage: node src/run.mjs <owner/repo> <issue number>")
  const config = loadConfig()
  redact = makeRedactor(secretValues(config))
  const info = {}
  const startedAt = Date.now()
  const once = (extra = {}) =>
    runIssue({
      config,
      repoName,
      issueNumber,
      runId,
      runUrl,
      eventName: process.env.GITHUB_EVENT_NAME,
      actor: process.env.GITHUB_ACTOR,
      token: process.env.FACTORY_GITHUB_TOKEN,
      redact,
      api: { getIssue, getHumanComments, listComments, addLabels, removeLabel, comment, openPullRequest },
      claimWorker,
      releaseWorker,
      info,
      emit: (event) => appendEvent(makeEvent({ ...event, runId, factory: config.factory.repo }, { redact })),
      startedAt,
      ...extra,
    })
  let outcome = await once()
  // The agent's provider reported a limit and a second pass still fits the run
  // budget: once more, on a worker of another agent type.
  if (outcome === "retry-elsewhere") outcome = await once({ continuing: true, excludeAgents: info.excludeAgents })
  const repoShown = findRepoName(config, repoName)
  writeJobSummary(summaryMarkdown({ outcome, repo: repoShown, issue: issueNumber, runUrl, info }))
  console.log(`::notice title=factory-stats::${JSON.stringify(statsRecord({ outcome, repo: repoShown, issue: issueNumber, runId, info }))}`)
  writeRunRecord(runRecord({ outcome, repo: repoShown, issue: issueNumber, runId, runUrl, info }))
  console.log(`\nOutcome: ${outcome}`)
  // An issue handed back to a person, or never started, is not a success.
  if (outcome === "needs-attention" || outcome === "no-worker") process.exitCode = 1
} catch (error) {
  console.error(`\nFactory run failed: ${redact(error.message)}`)
  writeJobSummary(`## Factory run\n\n**Failed**: ${redact(error.message).split("\n")[0].slice(0, 300)}\n`)
  writeRunRecord(runRecord({ outcome: "error", repo: repoName ?? null, issue: issueNumber, runId, runUrl, info: { reason: redact(error.message).split("\n")[0].slice(0, 300) } }))
  process.exitCode = 1
}
