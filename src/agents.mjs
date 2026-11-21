// Signs an agent in and runs it inside a Box. Agents are described in
// factory.config.json, so a new agent type needs no code change:
//
//   "auth":    secrets to place in the Box. Each entry has a "secret" name and
//              either "env" (export it as this variable) or "file" (write it to
//              this path).
//   "env":     extra environment variables for the agent.
//   "jobFiles": files from this repo that are copied into the Box at the start
//              of every job, such as a house CLAUDE.md or AGENTS.md. They are
//              read fresh each time, so editing them needs no image rebuild.
//   "command": the shell command. {prompt} is a file with the task, {summary}
//              is the file the agent's final reply must end up in.
//   "modelFlag": the flag that picks the model, such as --model. Only with it
//              can the router's model be applied (factory.orchestration.apply).
//              It goes where the command has {model}, else after the binary.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { q, sh, runScript } from "./box.mjs"
import { SAFE_MODEL } from "./core/probe.mjs"

const HOME = "/workspace/home"
// Everything one job writes (the checkout, prompt, logs, summary, patch) lives here.
export const WORK_DIR = `${HOME}/work`
const ENV_FILE = `${HOME}/.factory/env`
export const REPO_ENV_FILE = `${HOME}/.factory/repo-env`

// Finds a secret's value. In GitHub Actions every secret arrives as one JSON
// blob, so adding an agent does not mean editing the workflow. On the user's
// machine the value comes from .env, or from the entry's "localFile" (for
// example ~/.codex/auth.json), which is where some CLIs keep their login.
export function readSecret(entry) {
  if (process.env[entry.secret]) return process.env[entry.secret]
  try {
    const fromActions = JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}")[entry.secret]
    if (fromActions) return fromActions
  } catch {}
  const file = entry.localFile?.replace(/^~/, homedir())
  return file && existsSync(file) ? readFileSync(file, "utf8") : undefined
}

// The names of the secrets an agent type needs that have no value here. Checked
// before a worker is claimed, so a missing sign-in fails in seconds instead of
// after the repo setup has run.
export const missingSecrets = (config, agentName) => (config.agents[agentName]?.auth ?? []).filter((entry) => !readSecret(entry)).map((entry) => entry.secret)

// Every secret value this process can see, for masking them in comments and
// logs. Includes the whole Actions secrets blob, so a repo's test secret is
// masked too.
export function secretValues(config) {
  const entries = [{ secret: "FACTORY_GITHUB_TOKEN" }, { secret: "UPSTASH_BOX_API_KEY" }, ...Object.values(config.agents).flatMap((a) => a.auth ?? []), ...config.repos.flatMap((r) => r.secrets ?? [])]
  const values = entries.map(readSecret)
  try {
    values.push(...Object.values(JSON.parse(process.env.FACTORY_SECRETS_JSON ?? "{}")))
  } catch {}
  return values.filter((v) => typeof v === "string")
}

// Every path the factory writes secrets to, so they can be removed again.
export function secretPaths(config) {
  const files = Object.values(config.agents).flatMap((a) => (a.auth ?? []).filter((x) => x.file).map((x) => x.file))
  return [`${HOME}/.factory`, ...files]
}

// What the agent could still read once it has finished: its own sign-in. The
// repo's secrets file stays, because the checks that follow need it.
const agentSignInPaths = (config) => [ENV_FILE, ...secretPaths(config).filter((p) => p !== `${HOME}/.factory`)]

// Kills what the job left running. Only processes whose working directory is
// inside the job's folder are touched, never the Box's own services: an agent's
// forgotten dev server goes, upstash's daemons stay. A process that moved its
// working directory elsewhere before detaching is out of reach from here; the
// README names that as a residual risk.
const killJobProcesses = (box) =>
  sh(
    box,
    `for p in /proc/[0-9]*; do pid=\${p#/proc/}; [ "$pid" = "$$" ] && continue; cwd=$(readlink "$p/cwd" 2>/dev/null); case "$cwd" in ${WORK_DIR}|${WORK_DIR}/*) /bin/kill -KILL "$pid" 2>/dev/null;; esac; done; true`,
    { allowFailure: true },
  )

// Right after the agent: nothing the agent started may keep running next to the
// checks, and its sign-in is gone before the repo's own commands run.
export async function endAgentSession(box, config) {
  await killJobProcesses(box)
  await sh(box, `rm -rf ${agentSignInPaths(config).map(q).join(" ")}`)
}

// Removes everything a job left in the Box and PROVES it is gone, so a paused
// Box never holds the last job's code, prompt, logs or sign-in. Returns the
// paths that are still there. An empty list is the only "clean". A caller that
// gets leftovers keeps the worker claimed instead of handing a dirty Box on.
export async function scrubBox(box, config) {
  const paths = [...secretPaths(config), WORK_DIR, "~/.git-credentials"]
  try {
    await killJobProcesses(box)
    await sh(box, `rm -rf ${paths.map((p) => (p.startsWith("~/") ? p : q(p))).join(" ")}`, { allowFailure: true })
    const left = (await sh(box, `ls -d ${paths.map((p) => (p.startsWith("~/") ? p : q(p))).join(" ")} 2>/dev/null; true`, { allowFailure: true })).output
    return left.split("\n").map((l) => l.trim()).filter(Boolean)
  } catch (error) {
    return [`(could not check: ${error.message})`]
  }
}

export async function signIn(box, config, agentName) {
  const agent = config.agents[agentName]
  const lines = Object.entries(agent.env ?? {}).map(([key, value]) => `export ${key}=${q(value)}`)

  await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
  for (const entry of agent.auth ?? []) {
    const value = readSecret(entry)
    if (!value) throw new Error(`Secret ${entry.secret} is not set, and agent "${agentName}" needs it`)
    if (entry.env) lines.push(`export ${entry.env}=${q(value)}`)
    if (entry.file) {
      const dir = entry.file.slice(0, entry.file.lastIndexOf("/"))
      await sh(box, `mkdir -p ${q(dir)} && chmod 700 ${q(dir)}`)
      await box.files.write({ path: entry.file, content: value })
      await sh(box, `chmod 600 ${q(entry.file)}`)
    }
  }
  await box.files.write({ path: ENV_FILE, content: lines.join("\n") + "\n" })
  await sh(box, `chmod 600 ${ENV_FILE}`)
}

// Secrets a repo's own setup, tests and checks need, such as a test database
// URL. They go in their own file, which setup, checks and the agent all read.
// The agent's sign-in stays in a separate file that only the agent reads, so
// dependency install scripts never see it.
export async function writeRepoEnv(box, repo) {
  const lines = []
  for (const entry of repo.secrets ?? []) {
    const value = readSecret(entry)
    if (!value) throw new Error(`Secret ${entry.secret} is not set, and repo ${repo.repo} needs it`)
    lines.push(`export ${entry.env}=${q(value)}`)
  }
  await sh(box, `mkdir -p ${HOME}/.factory && chmod 700 ${HOME}/.factory`)
  await box.files.write({ path: REPO_ENV_FILE, content: lines.map((line) => `${line}\n`).join("") })
  await sh(box, `chmod 600 ${REPO_ENV_FILE}`)
}

// Copies the agent type's jobFiles from the factory repo into the Box.
export async function writeJobFiles(box, config, agentName) {
  for (const file of config.agents[agentName].jobFiles ?? []) {
    const content = readFileSync(new URL(file.from, config.baseUrl), "utf8").replaceAll("\r\n", "\n")
    const dir = file.to.slice(0, file.to.lastIndexOf("/"))
    await sh(box, `mkdir -p ${q(dir)}`)
    await box.files.write({ path: file.to, content })
  }
}

// The agent's command with the assigned model (docs 15 M-3: the orchestrator
// renders it, the agent cannot). The flag goes where the command has {model}
// (for a subcommand such as `opencode run {model}`), else right after the binary,
// past any leading NAME=value assignments.
export function withModel(agent, model) {
  if (model === undefined) return agent.command.replace(/\{model\} ?/g, "")
  if (!agent.modelFlag) throw new Error("this agent has no modelFlag, so a model cannot be applied")
  if (!SAFE_MODEL.test(model)) throw new Error(`"${model}" is not a model id`)
  const flag = `${agent.modelFlag} ${q(model)}`
  return agent.command.includes("{model}") ? agent.command.replaceAll("{model}", flag) : agent.command.replace(/^((?:\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\s*\S+)/, `$1 ${flag}`)
}

// Runs the agent with runScript, so it is in the background, in bash, and
// polled. The task goes in through a file, and the agent's final reply has to
// end up in the summary file, which becomes the pull request description.
export async function runAgent(box, config, agentName, { workDir, jobDir, prompt, timeoutMinutes, model }) {
  const promptFile = `${jobDir}/prompt.md`
  const summaryFile = `${jobDir}/summary.md`
  const command = withModel(config.agents[agentName], model).replaceAll("{prompt}", promptFile).replaceAll("{summary}", summaryFile)

  await sh(box, `mkdir -p ${q(jobDir)} ${q(workDir)} && rm -f ${summaryFile}`)
  // promptExtra is for agents that cannot put their reply into {summary} through
  // the command line. It can tell them to write the file themselves.
  const extra = (config.agents[agentName].promptExtra ?? "").replaceAll("{summary}", summaryFile)
  await box.files.write({ path: promptFile, content: [prompt, extra].filter(Boolean).join("\n") })
  const result = await runScript(box, {
    name: "agent",
    dir: jobDir,
    timeoutMinutes,
    onTick: (minutes) => console.log(`  agent still working (${minutes} min)`),
    body: [`source ${ENV_FILE}`, `source ${REPO_ENV_FILE} 2>/dev/null || true`, "export PATH=$HOME/.local/bin:$PATH", `cd ${q(workDir)} || exit 97`, command],
  })

  // Empty when the agent's command did not get its reply into {summary}. The
  // smoke test warns about that, because the pull request text comes from here.
  // Capped at the source: an agent that wrote gigabytes must not be read whole.
  const summary = (await sh(box, `head -c 200000 ${summaryFile} 2>/dev/null`, { allowFailure: true })).output.trim()
  return { ...result, summary }
}
