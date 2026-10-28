// Checks the local setup without changing anything and without printing a
// secret: tools, the config, which secrets have a value, whether the GitHub
// token reaches every repo, and whether the Box key works.
//
// Run with: node --env-file=.env scripts/check-setup.mjs [--probe-writes]
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { loadConfig, usedAgents, worstPassMinutes, secondPassMinutes, runBudgetMinutes } from "../src/config.mjs"
import { readSecret } from "../src/agents.mjs"
import { describeBoxSettings } from "../src/box.mjs"
import { hintFor } from "../src/github.mjs"

let problems = 0
const ok = (text) => console.log(`  ok    ${text}`)
const bad = (text) => (problems++, console.log(`  FIX   ${text}`))
const note = (text) => console.log(`  note  ${text}`)

console.log("Tools")
const [major, minor] = process.versions.node.split(".").map(Number)
major > 20 || (major === 20 && minor >= 6) ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old. --env-file needs 20.6 or newer`)
for (const tool of ["git", "gh"]) {
  spawnSync(tool, ["--version"]).status === 0 ? ok(`${tool} is installed`) : bad(`${tool} is not installed`)
}
const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" })
const ghText = `${gh.stdout}${gh.stderr}`
gh.status === 0 ? ok(`gh is signed in${/workflow/.test(ghText) ? "" : ". Its token may lack the workflow scope, which pushing workflow files needs"}`) : bad("gh is not signed in. Run: gh auth login")

console.log("\nConfig")
let config
try {
  config = loadConfig()
  ok(`${config.repos.length} repos, ${config.workers.filter((w) => w.enabled).length} enabled workers, agent types in use: ${usedAgents(config).join(", ")}`)
  for (const name of usedAgents(config)) note(`${name}: ${describeBoxSettings(config, name)}`)
} catch (error) {
  bad(error.message)
}

if (config) {
  console.log("\nSecrets (values are never shown)")
  const entries = [{ secret: "UPSTASH_BOX_API_KEY" }, { secret: "FACTORY_GITHUB_TOKEN" }, ...usedAgents(config).flatMap((name) => config.agents[name].auth ?? []), ...config.repos.flatMap((r) => r.secrets ?? [])]
  for (const entry of entries) {
    const value = readSecret(entry)
    value ? ok(`${entry.secret} is set (${value.length} characters)`) : bad(`${entry.secret} has no value in .env${entry.localFile ? ` or in ${entry.localFile}` : ""}`)
  }

  console.log("\nGitHub token")
  const token = process.env.FACTORY_GITHUB_TOKEN
  // Tells the four ways a call can fail apart: no answer at all, a bad token,
  // a missing permission, and a repo the token cannot see.
  const call = async (path, init = {}) => {
    try {
      const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(30_000) })
      return { status: response.status, text: await response.text() }
    } catch (error) {
      return { status: 0, text: `${error.name === "TimeoutError" ? "no answer within 30 s" : "network error"}: ${error.cause?.code ?? error.message}` }
    }
  }
  const explain = ({ status, text }) => (status === 0 ? `${text}. Check the network or GitHub's status page` : `HTTP ${status}. ${hintFor(status, text)}`)

  if (token) {
    const me = await call("/user")
    if (me.status === 200) ok(`the token works and belongs to ${JSON.parse(me.text).login}`)
    else if (me.status === 401) bad(`the token is not accepted: ${explain(me)}`)
    else if (me.status === 0) bad(`GitHub could not be reached: ${explain(me)}`)
    else note(`GET /user answered ${me.status}. Fine-grained tokens can be refused there; the repo checks below are what count`)
  }
  for (const repo of [config.factory.repo, ...config.repos.map((r) => r.repo)]) {
    if (!token) break
    const response = await call(`/repos/${repo}`)
    // The workflow's one-run-per-issue rule compares names as written, so the
    // config must spell each repo the way GitHub does.
    const fullName = response.status === 200 ? JSON.parse(response.text).full_name : null
    if (fullName && fullName !== repo) bad(`${repo} is spelled "${fullName}" on GitHub. Use that spelling in factory.config.json`)
    else if (fullName) ok(`${repo} is reachable`)
    else bad(`${repo}: ${explain(response)} A fine-grained token covers ONE owner, so the factory repo and the app repos need the same owner, and an organisation may have to approve the token first`)
  }
  note("The token needs, on the factory repo AND every app repo: Contents read/write (pushing branches, and the trigger's repository_dispatch), Issues read/write, Pull requests read/write. Metadata read comes with them.")

  // Fine-grained tokens cannot list their own permissions, and reachable is not
  // writable. These probes send write requests that GitHub must refuse as
  // invalid (an empty label name, an empty pull request, a malformed ref), so
  // nothing is created. GitHub checks permission before it checks the request,
  // so 422 means "allowed" and 403 means "missing permission". The dispatch to
  // the factory repo is real but names an event nothing listens to.
  if (token && process.argv.includes("--probe-writes")) {
    console.log("\nWrite permissions (probes, nothing is created)")
    const verdict = (what, r, allowed) => (allowed.includes(r.status) ? ok(`${what}: allowed`) : bad(`${what}: ${explain(r)}`))
    verdict(`${config.factory.repo} Contents write (repository_dispatch)`, await call(`/repos/${config.factory.repo}/dispatches`, { method: "POST", body: JSON.stringify({ event_type: "factory-permission-probe" }) }), [204])
    for (const { repo } of config.repos) {
      verdict(`${repo} Issues write`, await call(`/repos/${repo}/labels`, { method: "POST", body: JSON.stringify({ name: "" }) }), [422])
      verdict(`${repo} Pull requests write`, await call(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({}) }), [422])
      verdict(`${repo} Contents write`, await call(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: "refs/heads/factory-probe", sha: "0000000000000000000000000000000000000000" }) }), [422])
    }
    note("A probe proves the permission for the token, not the trigger's secret in the app repo. The first dry run through GitHub proves that.")
  } else if (token) {
    note("Reachable is not proof of write access. Add --probe-writes to test the write permissions without creating anything.")
  }

  console.log("\nTriggers in the app repos")
  if (!token) note("skipped: FACTORY_GITHUB_TOKEN has no value")
  for (const { repo } of config.repos) {
    if (!token) break
    // No ref: GitHub only runs an issues workflow from the default branch, and
    // that is the branch the contents API reads without one.
    const response = await call(`/repos/${repo}/contents/.github/workflows/factory-ready.yml`)
    if (response.status === 200) ok(`${repo} has the trigger on its default branch. It also needs the FACTORY_GITHUB_TOKEN secret, which this script cannot see`)
    else if (response.status === 404) bad(`${repo} has no .github/workflows/factory-ready.yml on its default branch (or the token cannot read it), so labelling an issue there starts nothing. Run: node scripts/install-trigger.mjs --yes`)
    else bad(`${repo}: could not read the trigger: ${explain(response)}`)
  }

  console.log("\nUpstash Box")
  // A missing key is already reported above. Only a key that is set can be wrong.
  if (!process.env.UPSTASH_BOX_API_KEY) note("skipped: UPSTASH_BOX_API_KEY has no value")
  else try {
    const boxes = await Box.list()
    ok(`the Box key works. ${boxes.length} Boxes on the account`)

    // Whatever is on the account and is not one of our workers, or our smoke
    // Box, belongs to something else, even if it shares our label or prefix.
    const prefix = config.factory.boxNamePrefix
    const workerNames = new Set(config.workers.map((w) => `${prefix}${w.id}`))
    const isOurs = (b) => workerNames.has(b.name) || ((b.name ?? "").startsWith(`${prefix}smoke-`) && (b.labels ?? []).includes(config.factory.boxLabel))
    const foreign = boxes.filter((b) => !isOurs(b))
    const clash = foreign.filter((b) => (b.labels ?? []).includes(config.factory.boxLabel) || (b.name ?? "").startsWith(prefix))
    if (clash.length) bad(`${clash.length} Boxes that are not this factory's workers share its label "${config.factory.boxLabel}" or its name prefix "${prefix}": ${clash.map((b) => b.name).join(", ")}. Choose another label and prefix, or scripts that select by label could touch them`)

    // The Box budget. Paused Boxes count toward the plan's limit.
    const wanted = config.workers.filter((w) => w.enabled).length
    const existing = boxes.filter((b) => workerNames.has(b.name)).length
    const limit = config.factory.boxLimit
    if (limit) {
      const spare = limit - foreign.length - wanted
      const line = `Box budget: limit ${limit} - ${foreign.length} Boxes of other projects - ${wanted} workers = ${spare} spare`
      if (spare < 0) bad(`${line}. The workers do not fit`)
      else if (spare === 0) note(`${line}. No slot is left for a smoke test once every worker has a Box (${existing} exist now)`)
      else ok(`${line} (${existing} worker Boxes exist now). Run smoke tests one at a time, and remember that --keep holds a slot`)
    } else {
      note(`This factory wants ${wanted} worker Boxes and ${foreign.length} other Boxes are on the account. Set factory.boxLimit to the plan's Box limit and this check does the sum. Paused Boxes count`)
    }
  } catch (error) {
    bad(`the Box key was refused, or Upstash could not be reached: ${error.message}`)
  }

  console.log("\nTimeouts")
  const f = config.factory
  const worst = worstPassMinutes(config)
  let workflowLimit = null
  try {
    // The tightest limit counts: the work step's own, which sits below the job's.
    const limits = [...readFileSync(new URL("../.github/workflows/factory.yml", import.meta.url), "utf8").matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 10)
    workflowLimit = limits.length ? Math.min(...limits) : null
  } catch {}
  const sum = `worst case for one run: wait ${f.waitForWorkerMinutes ?? 30} + setup and two rounds of checks 3 x ${f.commandTimeoutMinutes ?? 20} + two agent runs 2 x ${f.agentTimeoutMinutes ?? 25} = ${worst} min`
  if (!workflowLimit) note(`${sum}. Could not read timeout-minutes from the workflow`)
  else if (worst + 10 > workflowLimit) bad(`${sum}, but the workflow stops at ${workflowLimit}. A run killed by that limit skips its cleanup and leaves the worker busy. Raise timeout-minutes or lower the config timeouts`)
  else ok(`${sum}, inside the workflow's ${workflowLimit}`)
  // A fallback to another agent type starts a second pass, but only when it still fits this budget.
  const budget = runBudgetMinutes(config)
  note(`Fallback to another agent type needs ${secondPassMinutes(config)} min for its pass (wait at most ${Math.min(10, f.waitForWorkerMinutes ?? 30)}, setup, one agent run, one round of checks) and starts only if that still ends inside ${budget} min of the run`)
  if (workflowLimit && budget + 10 > workflowLimit) bad(`factory.runBudgetMinutes is ${budget}, but the workflow stops at ${workflowLimit}. A second pass after a provider limit must still finish with 10 minutes to spare. Lower runBudgetMinutes or raise timeout-minutes`)
}

console.log(problems ? `\n${problems} thing(s) to fix.` : "\nAll good.")
process.exitCode = problems ? 1 : 0
