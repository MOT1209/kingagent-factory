// What the operator sees without opening a log: a short Markdown block on the
// workflow run's summary page, and a one-line JSON record of the run that a
// later report can add up. Pure functions, so the tests need no workflow.
import { appendFileSync } from "node:fs"

const OUTCOME_TEXT = {
  review: "Pull request opened. Review it; the factory never merges.",
  "needs-attention": "Handed back to a person. Read the issue comment for the reason.",
  "no-worker": "No free worker in time. The issue kept its ready label.",
  skipped: "Nothing to do: the issue is closed or no longer ready.",
  owned: "Another run already owns this issue.",
  changed: "The issue changed while the run waited. Left alone.",
  "retry-elsewhere": "The first agent hit a provider limit; another agent type took over.",
}

// `info` is filled in by runIssue: worker, agent, agentMinutes, attempts, reason, prUrl.
export function summaryMarkdown({ outcome, repo, issue, runUrl, info = {} }) {
  const rows = [
    ["Issue", `${repo}#${issue}`],
    ["Outcome", `**${outcome}**: ${OUTCOME_TEXT[outcome] ?? ""}`.trim()],
    info.worker && ["Worker", `${info.worker} (${info.agent})`],
    info.attempts > 1 && ["Attempts", `${info.attempts} (a provider limit moved the issue to another agent)`],
    info.agentMinutes !== undefined && ["Agent time", `${Number(info.agentMinutes).toFixed(1)} min`],
    info.prUrl && ["Pull request", info.prUrl],
    info.reason && ["Reason", info.reason],
    runUrl && ["Run", runUrl],
  ].filter(Boolean)
  return `## Factory run\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v).replaceAll("|", "\\|").replaceAll("\n", " ")} |`).join("\n")}\n`
}

// One machine-readable line per run, for scripts/report.mjs to total up.
export const statsRecord = ({ outcome, repo, issue, runId, info = {} }) => ({
  runId: String(runId),
  repo,
  issue: Number(issue),
  outcome,
  agent: info.agent ?? null,
  worker: info.worker ?? null,
  agentMinutes: Number((info.agentMinutes ?? 0).toFixed(2)),
  attempts: info.attempts ?? 1,
})

// Appends to the job summary file GitHub provides. Outside Actions there is
// none, and this does nothing. A failure to write must never fail a run.
export function writeJobSummary(text, env = process.env, append = appendFileSync) {
  const file = env.GITHUB_STEP_SUMMARY
  if (!file) return false
  try {
    append(file, `${text}\n`)
    return true
  } catch {
    return false
  }
}

// --- totals over many runs ---------------------------------------------------
// Reads the `::notice title=factory-stats::{...}` lines that run.mjs prints
// (from `gh run view <id> --log`, or several runs' logs concatenated) and totals
// them: runs, outcomes, agent minutes and success rate per agent.
export function aggregateStats(text) {
  const records = []
  for (const line of String(text).split("\n")) {
    const at = line.indexOf("title=factory-stats::")
    if (at < 0) continue
    try {
      records.push(JSON.parse(line.slice(at + "title=factory-stats::".length)))
    } catch {
      // a cut or garbled line is skipped, not fatal
    }
  }
  // One run can appear twice when logs overlap; the run id and issue identify it.
  const unique = [...new Map(records.map((r) => [`${r.runId}:${r.repo}#${r.issue}`, r])).values()]
  const byAgent = {}
  const outcomes = {}
  for (const r of unique) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    const key = r.agent ?? "none"
    const a = (byAgent[key] ??= { runs: 0, review: 0, minutes: 0 })
    a.runs++
    a.minutes = Number((a.minutes + (r.agentMinutes ?? 0)).toFixed(2))
    if (r.outcome === "review") a.review++
  }
  for (const a of Object.values(byAgent)) a.successRate = a.runs ? Number((a.review / a.runs).toFixed(2)) : 0
  return { runs: unique.length, outcomes, byAgent, agentMinutes: Number(Object.values(byAgent).reduce((s, a) => s + a.minutes, 0).toFixed(2)) }
}
