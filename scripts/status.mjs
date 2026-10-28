// Shows every worker, whether it is free or busy, the state of its Box, and for
// a busy one whether the run that holds it is still going. Read-only.
//
// Run with: node --env-file=.env scripts/status.mjs [--json]
// With GITHUB_TOKEN (or FACTORY_GITHUB_TOKEN) able to read this repo's Actions
// runs, claims are checked against GitHub; without it they show as unknown.
import { loadConfig } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"
import { getWorkflowRun } from "../src/github.mjs"
import { describeWorkers, advice } from "../src/ops.mjs"

const config = loadConfig()
const token = process.env.GITHUB_TOKEN ?? process.env.FACTORY_GITHUB_TOKEN
const rows = await describeWorkers(await getWorkerStates(config), token ? (id) => getWorkflowRun(config.factory.repo, id, token) : async () => null)

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ workers: rows, advice: advice(rows) }, null, 2))
} else {
  for (const w of rows) {
    const claims = w.claims.map((c) => `${c.label}=${c.state}`).join(",")
    console.log(`${w.id.padEnd(16)} ${w.agent.padEnd(15)} ${w.state.padEnd(9)} Box: ${String(w.box).padEnd(12)} ${(w.boxId ?? "").padEnd(24)} ${claims}`)
  }
  const count = (state) => rows.filter((w) => w.state === state).length
  console.log(`\n${count("free")} free, ${count("busy")} busy, ${count("disabled")} disabled`)
  for (const line of advice(rows)) console.log(`  todo  ${line}`)
}
