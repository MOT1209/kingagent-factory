// One command for "is the factory healthy": the setup check, then the worker
// status. Read-only. Exit code 0 only when both are clean and no worker needs
// attention, so it can run from a scheduled job.
//
// Run with: node --env-file=.env scripts/doctor.mjs
import { spawnSync } from "node:child_process"

const run = (script, args = []) => spawnSync(process.execPath, [new URL(script, import.meta.url).pathname, ...args], { encoding: "utf8", env: process.env })

console.log("== Setup ==")
const setup = run("./check-setup.mjs")
console.log(setup.stdout.trimEnd())
if (setup.stderr.trim()) console.error(setup.stderr.trim())

console.log("\n== Workers ==")
const status = run("./status.mjs", ["--json"])
let todo = []
try {
  const parsed = JSON.parse(status.stdout)
  for (const w of parsed.workers) console.log(`  ${w.id.padEnd(14)} ${w.agent.padEnd(10)} ${w.state.padEnd(9)} ${w.claims.map((c) => `${c.label}=${c.state}`).join(",")}`)
  todo = parsed.advice
  for (const line of todo) console.log(`  todo  ${line}`)
} catch {
  const lines = (status.stderr || status.stdout).trim().split("\n")
  console.log(`  could not read the workers: ${lines.find((l) => /error|not set|missing|key/i.test(l)) ?? lines[0]}`)
  todo = ["workers unreadable"]
}

const healthy = setup.status === 0 && todo.length === 0
console.log(healthy ? "\nHealthy." : "\nNeeds attention (see FIX and todo lines above).")
process.exitCode = healthy ? 0 : 1
