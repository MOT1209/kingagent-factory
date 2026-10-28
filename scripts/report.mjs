// Totals the factory's runs from their logs: runs, outcomes, agent minutes and the
// share of runs that ended in a pull request, per agent. Read-only; reads text.
//
//   gh run view <run id> --log | node scripts/report.mjs
//   for id in $(gh run list --workflow Factory --json databaseId -q '.[].databaseId'); do gh run view $id --log; done | node scripts/report.mjs
import { readFileSync } from "node:fs"
import { aggregateStats } from "../src/report.mjs"

const stats = aggregateStats(readFileSync(0, "utf8"))
if (process.argv.includes("--json")) console.log(JSON.stringify(stats, null, 2))
else {
  console.log(`${stats.runs} runs, ${stats.agentMinutes} agent minutes`)
  console.log(`Outcomes: ${Object.entries(stats.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`)
  for (const [agent, a] of Object.entries(stats.byAgent)) console.log(`  ${agent.padEnd(12)} ${a.runs} runs, ${a.review} pull requests (${Math.round(a.successRate * 100)}%), ${a.minutes} min`)
}
