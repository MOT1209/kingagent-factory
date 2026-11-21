// The capability probe of docs/architecture/15 §6 (risk R-36): can this agent
// type's CLI take a model per task, and which model actually answers?
// Creates ONE Box the way smoke-test.mjs does, signs the agent in the same way,
// reads the CLI version and whether its help lists a model flag, then for each
// requested model runs a trivial task with that flag and records the model the
// CLI reports it used. Prints registry entries; --out writes them as JSON.
//
// Preview: node --env-file=.env scripts/probe-models.mjs <agent type> --model <id> [--model <id> ...]
// Run:     node --env-file=.env scripts/probe-models.mjs <agent type> --model <id> ... --yes [--out file.json]
//
// The Box is deleted at the end. It was created by this script and holds nothing.
import { writeFileSync } from "node:fs"
import { loadConfig } from "../src/config.mjs"
import { sh, createAgentBox, requireBoxSettings } from "../src/box.mjs"
import { signIn, writeJobFiles, runAgent, secretPaths } from "../src/agents.mjs"
import { ADAPTERS, PROMPT, SAFE_MODEL, verdict } from "../src/core/probe.mjs"

const args = process.argv.slice(2)
const valueOf = (i) => ["--model", "--out"].includes(args[i - 1])
const agentName = args.find((a, i) => !a.startsWith("--") && !valueOf(i))
const models = args.filter((a, i) => args[i - 1] === "--model")
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null
const adapter = ADAPTERS[agentName]
const config = loadConfig()
if (!adapter || !config.agents[agentName] || !models.length) {
  console.error(`Usage: probe-models.mjs <${Object.keys(ADAPTERS).join("|")}> --model <id> [--model <id> ...] [--yes] [--out file.json]`)
  process.exit(1)
}
const bad = models.filter((m) => !SAFE_MODEL.test(m))
if (bad.length) {
  console.error(`Not a plain model id: ${bad.join(", ")}`)
  process.exit(1)
}
requireBoxSettings(config, agentName)

const name = `${config.factory.boxNamePrefix}probe-${agentName}`
console.log(`Box to create: ${name}. Models to probe: ${models.join(", ")}. The Box is deleted at the end.`)
if (!args.includes("--yes")) {
  console.log(`\nPreview only. Add --yes to run it. It uses one Box slot and ${models.length} short task(s) of the agent's quota.`)
  process.exit(0)
}

const box = await createAgentBox(config, agentName, name, [config.factory.boxLabel, "probe"])
console.log(`Created Box ${box.id}`)
const entries = []
try {
  const version = (await sh(box, `${adapter.binary} --version`, { allowFailure: true })).output.trim().split("\n")[0] || null
  const help = (await sh(box, `${adapter.help} 2>&1`, { allowFailure: true })).output
  const hasFlag = help.includes(adapter.flag)
  console.log(`CLI: ${version ?? "(no version)"}. Help lists ${adapter.flag}: ${hasFlag ? "yes" : "no"}`)

  await signIn(box, config, agentName)
  await writeJobFiles(box, config, agentName)
  for (const model of models) {
    const facts = { requested: model, code: null, reply: "", modelsUsed: [] }
    if (!hasFlag) facts.error = `the CLI help does not list ${adapter.flag}`
    else {
      // Only the command changes; sign-in, environment and runner are the factory's own.
      const command = adapter.command.replaceAll("{model}", `'${model}'`)
      const probeConfig = { ...config, agents: { ...config.agents, [agentName]: { ...config.agents[agentName], command, promptExtra: undefined } } }
      const result = await runAgent(box, probeConfig, agentName, { workDir: "/workspace/home/probe", jobDir: "/workspace/home/probe/.job", prompt: PROMPT, timeoutMinutes: 5 })
      facts.code = result.code
      try {
        Object.assign(facts, adapter.parse(result.summary))
      } catch {
        if (result.code === 0) facts.error = "the CLI's report could not be read as JSON"
      }
    }
    const v = verdict(facts)
    entries.push({ provider: agentName, model, status: v.status, verified_at: v.status === "verified" ? new Date().toISOString() : null, cli_version: version, models_reported: facts.modelsUsed, ...(v.reason ? { reason: v.reason } : {}) })
    console.log(`${model}: ${v.status}${v.reason ? ` (${v.reason})` : ""}${facts.modelsUsed.length ? `; the CLI reports ${facts.modelsUsed.join(", ")}` : ""}`)
  }
} catch (error) {
  console.error(`\n${error.message}`)
  process.exitCode = 1
} finally {
  await sh(box, `rm -rf /workspace/home/probe ${secretPaths(config).map((p) => `'${p}'`).join(" ")}`, { allowFailure: true }).catch(() => {})
  await box.delete()
  console.log(`Deleted Box ${box.id}.`)
}

console.log(`\n${JSON.stringify(entries, null, 2)}`)
if (out) writeFileSync(out, JSON.stringify({ probed_at: new Date().toISOString(), entries }, null, 2) + "\n")
if (!process.exitCode) process.exitCode = entries.length && entries.every((e) => e.status === "verified") ? 0 : 1
