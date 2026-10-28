// Claiming, using and releasing a worker Box.
import { Box } from "@upstash/box"
import { getWorkerStates, pickWorker } from "./workers.mjs"

const BOX_TIMEOUT_MS = 15 * 60 * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// How often runScript looks at a background script. Tests shorten it.
export const timing = { pollMs: 10_000 }

// Quotes a value for use inside a shell command.
export const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Runs a short shell command in the Box and returns its output and exit code.
// Throws on a non-zero exit code unless allowFailure is set.
//
// The Box runs this with plain `sh`, not bash, and the call holds one HTTP
// request open until the command ends. Use runScript for anything that needs
// bash or may run for more than a minute.
export async function sh(box, command, { allowFailure = false } = {}) {
  const run = await box.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`)
  const match = /__EXIT__(\d+)\s*$/.exec(run.result ?? "")
  const code = match ? Number(match[1]) : run.status === "completed" ? 0 : 1
  const output = (run.result ?? "").replace(/__EXIT__\d+\s*$/, "").trimEnd()
  if (code !== 0 && !allowFailure) {
    throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`)
  }
  return { code, output }
}

// Runs a bash script in the Box in the background and polls until it ends.
// This is how everything slow runs: the agent, repo setup, checks, the image
// build. The script runs as a login shell, so /etc/profile.d applies, and all
// its lines share one shell, so `source venv/bin/activate` carries over.
//
// A line "#STEP some name" in the body marks a step. The name of the last
// step that started comes back as `step`, which tells you which check failed.
export async function runScript(box, { name, dir, body, timeoutMinutes = 20, onTick }) {
  const base = `${dir}/${name}`
  const script = ["#!/bin/bash", `exec > ${base}.log 2>&1`, ...body.map((line) => (line.startsWith("#STEP ") ? `echo ${q(line.slice(6))} > ${base}.step` : line)), ""].join("\n")
  await sh(box, `mkdir -p ${q(dir)} && rm -f ${base}.exit ${base}.step ${base}.log ${base}.pid`)
  await box.files.write({ path: `${base}.sh`, content: script })
  // setsid gives the script its own process group, so everything it starts (the
  // agent, a dev server the agent forgot) can be stopped together afterwards.
  await sh(box, `nohup setsid bash -lc ${q(`echo $$ > ${base}.pid; bash ${base}.sh; echo $? > ${base}.exit`)} > /dev/null 2>&1 & echo started`)
  // /bin/kill, because the kill built into the Box's sh does not accept a process group.
  const stopGroup = () => sh(box, `/bin/kill -TERM -- -$(cat ${base}.pid) 2>/dev/null; sleep 1; /bin/kill -KILL -- -$(cat ${base}.pid) 2>/dev/null; true`, { allowFailure: true })

  const started = Date.now()
  while (Date.now() - started < timeoutMinutes * 60 * 1000) {
    await sleep(timing.pollMs)
    const { output } = await sh(box, `cat ${base}.exit 2>/dev/null || echo running`)
    const minutes = ((Date.now() - started) / 60000).toFixed(1)
    if (output.trim() === "running") {
      onTick?.(minutes)
      continue
    }
    const log = (await sh(box, `tail -n 80 ${base}.log 2>/dev/null`, { allowFailure: true })).output
    const step = (await sh(box, `cat ${base}.step 2>/dev/null`, { allowFailure: true })).output.trim()
    await stopGroup() // background processes the script left running
    return { code: Number(output.trim()), log, step, minutes }
  }
  await stopGroup()
  throw new Error(`"${name}" did not finish within ${timeoutMinutes} minutes.`)
}

// The model and effort question must be answered before a Box is made. The
// template ships with "boxSettings": "ask", and this is where that is refused.
export function requireBoxSettings(config, agentName) {
  if (!Array.isArray(config.agents[agentName].boxSettings)) {
    throw new Error(
      `Agent type "${agentName}" still has "boxSettings": "ask". Before any Box or snapshot is created for it, ask the user whether these workers should use the CLI's own default model and reasoning effort or specific ones. Then set boxSettings to [] for the defaults, or fill it in (see references/agents.md in the skill).`,
    )
  }
}

// Writes an agent type's default settings into a Box: the model, the reasoning
// effort, or anything else its CLI reads from a user-level settings file. They
// live in the Box (and in any snapshot taken from it), not on the command line.
//
//   { "path": "...", "format": "json", "values": { ... } }  merged into the JSON file
//   { "path": "...", "format": "toml", "values": { ... } }  merged as top-level TOML keys
//   { "path": "...", "format": "text", "content": "..." }   replaces the file
//
// Merging matters. Codex, for one, keeps its own entries in config.toml.
export async function applyBoxSettings(box, config, agentName) {
  requireBoxSettings(config, agentName)
  for (const setting of config.agents[agentName].boxSettings) {
    const dir = setting.path.slice(0, setting.path.lastIndexOf("/"))
    await sh(box, `mkdir -p ${q(dir)}`)
    const existing = (await sh(box, `cat ${q(setting.path)} 2>/dev/null`, { allowFailure: true })).output

    let content = setting.content ?? ""
    if (setting.format === "json") {
      let current = {}
      try {
        current = JSON.parse(existing || "{}")
      } catch {}
      content = JSON.stringify({ ...current, ...setting.values }, null, 2) + "\n"
    } else if (setting.format === "toml") {
      // Top-level keys must come before the first [table] header.
      const lines = existing ? existing.split("\n") : []
      const firstTable = lines.findIndex((line) => line.trim().startsWith("["))
      const head = firstTable < 0 ? lines : lines.slice(0, firstTable)
      const tables = firstTable < 0 ? [] : lines.slice(firstTable)
      const keys = Object.keys(setting.values)
      const isOurs = (line) => keys.some((key) => line.trim().startsWith(key) && /^\s*=/.test(line.trim().slice(key.length)))
      const kept = head.filter((line) => line.trim() && !isOurs(line))
      const added = Object.entries(setting.values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      content = [...added, ...kept, "", ...tables].join("\n").trimEnd() + "\n"
    }
    await box.files.write({ path: setting.path, content })
  }
}

// One line that says which defaults a Box of this agent type gets. Shown in
// previews so nobody bakes in a model without noticing.
export function describeBoxSettings(config, agentName) {
  const settings = config.agents[agentName].boxSettings
  if (!Array.isArray(settings)) return "NOT DECIDED YET (boxSettings is \"ask\")"
  if (settings.length === 0) return "the CLI's own default model and effort"
  return settings.map((s) => `${s.path.split("/").pop()}: ${s.values ? JSON.stringify(s.values) : "custom file"}`).join("; ")
}

// Browser access (Upstash's own Chromium, `box.browser`) is on unless the config
// says otherwise. It is fixed when a Box is created and cannot be added later.
export const wantsBrowser = (config) => config.factory.browser ?? true

// Options for every Box this factory creates. `browser` only counts in
// Box.create. Box.fromSnapshot does not send it: a Box made from a snapshot has
// browser access exactly when the Box the snapshot was taken from had it.
export function boxOptions(config, name, labels) {
  return { name, labels, runtime: config.factory.runtime ?? "node", browser: wantsBrowser(config), timeout: BOX_TIMEOUT_MS }
}

// Whether a Box has browser access. Listing tabs does not start Chromium, and a
// Box without browser access answers "browser is not enabled for this box".
export async function hasBrowser(box) {
  try {
    await box.browser.listTabs()
    return true
  } catch (error) {
    if (/not enabled/i.test(error.message)) return false
    throw error
  }
}

// What to tell someone whose Box lacks the browser access the config asks for.
export const browserMissingHelp = (config, agentName) =>
  imageFor(config, agentName)
    ? `It came from a worker image, and an image passes on the browser access of the Box it was built in. Passing browser: true to Box.fromSnapshot changes nothing. Delete this Box, create a plain browser-enabled one (remove the snapshotId from factory.config.json for a moment), rebuild the image in it with scripts/build-snapshot.mjs, then create the workers from the new image.`
    : `Browser access cannot be added to an existing Box. Delete this Box and create it again (the user runs scripts/delete-workers.mjs, then scripts/provision-workers.mjs), or set "browser": false under "factory" if these workers should not have one.`

// Upstash's Chromium only starts when a first tab is opened. After that it
// listens on port 9222 inside the Box, where a tool such as agent-browser can
// attach to it. A job goes on without a browser when this fails.
export async function startBrowser(box, config) {
  if (!wantsBrowser(config)) return false
  try {
    await box.browser.tab.create("about:blank")
    return true
  } catch (error) {
    console.warn(`Could not start the Box's browser (${error.message}). The job goes on without it.`)
    return false
  }
}

// Creates a worker's Box. An agent type can have its own worker image
// (agents.<name>.snapshotId). Otherwise the shared image (factory.snapshotId)
// is used, and without any image a plain Upstash Box. The agent type's default
// settings are written into the new Box either way.
export const createWorkerBox = (config, worker) => createAgentBox(config, worker.agent, worker.boxName, [config.factory.boxLabel, `agent-${worker.agent}`])

// Also used by the smoke test, so that it tests the same Box a worker would get,
// including an agent CLI that only exists in the worker image.
export async function createAgentBox(config, agentName, name, labels) {
  requireBoxSettings(config, agentName)
  const options = boxOptions(config, name, labels)
  const snapshotId = imageFor(config, agentName)
  const box = snapshotId ? await Box.fromSnapshot(snapshotId, options) : await Box.create(options)
  await applyBoxSettings(box, config, agentName)
  return box
}

export const imageFor = (config, agentName) => config.agents[agentName].snapshotId ?? config.factory.snapshotId ?? null

// Waits for a free worker and claims its Box.
//
// Box labels have no compare-and-set, so the claim is built from two steps
// that are each atomic: adding a label, and listing the labels.
//
//   1. Skip a Box that already carries `busy` or any "run-" label.
//   2. Add this run's own label, "run-<run id>".
//   3. List the labels again. If any other "run-" label is there, remove ours,
//      wait a random moment and start over. Otherwise the Box is ours, and only
//      then is `busy` added, as a hint for status and the worker list.
//
// Two runs can never both get past step 3: whichever of them listed first
// had already added its label, so the other one's list shows it. In the worst
// case both retreat and retry. This holds as long as Upstash answers a label
// list with every label added before it, which the factory assumes.
//
// `deps` exists for the tests, which race claimers against in-memory Boxes.
export const runLabelFor = (runId) => `run-${runId}`.slice(0, 20)
export const isRunLabel = (label) => label.startsWith("run-")

const defaultDeps = {
  getStates: getWorkerStates,
  getBox: (id) => Box.get(id, { timeout: BOX_TIMEOUT_MS }),
  createBox: createWorkerBox,
  sleep,
  log: console.log,
}

export async function claimWorker(config, issueLabels, runId, deps = {}) {
  const { getStates, getBox, createBox, sleep: wait, log, excludeAgents = [], waitMinutes } = { ...defaultDeps, ...deps }
  const runLabel = runLabelFor(runId)
  const busy = config.factory.busyLabel
  const deadline = Date.now() + (waitMinutes ?? config.factory.waitForWorkerMinutes ?? 30) * 60 * 1000
  const backOff = () => wait(1_000 + Math.random() * 4_000)

  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const spread = Number(String(runId).replace(/\D/g, "").slice(-6)) + attempt
    const worker = pickWorker(await getStates(config), issueLabels, spread, config.agents, excludeAgents)
    if (!worker) {
      // A worker is freed by another run at an unpredictable moment; polling every
      // 10-15 s (jittered, so waiting runs do not all ask at once) finds it sooner
      // than a fixed 30 s, and Box.list is one cheap call.
      const pause = Math.round(10_000 + Math.random() * 5_000)
      log(`No free worker. Checking again in ${Math.round(pause / 1000)} seconds.`)
      await wait(pause)
      continue
    }

    let box
    let labelled = false
    try {
      box = worker.boxId ? await getBox(worker.boxId) : (log(`Creating Box ${worker.boxName}...`), await createBox(config, worker))
      const held = (await box.labels.list()).filter((l) => l === busy || isRunLabel(l))
      if (held.length) {
        log(`Worker ${worker.id} was taken meanwhile (${held.join(", ")}). Trying another.`)
        await backOff()
        continue
      }
      // A Box holds at most five labels, so a crowded Box can refuse the label.
      // That also means other runs are on it.
      await box.labels.add(runLabel)
      labelled = true
      const rivals = (await box.labels.list()).filter((l) => isRunLabel(l) && l !== runLabel)
      if (rivals.length) {
        log(`Another run reached worker ${worker.id} at the same moment (${rivals.join(", ")}). Backing off.`)
        await box.labels.remove(runLabel)
        labelled = false
        await backOff()
        continue
      }
      await box.labels.add(busy)
      // A Box that cannot be woken is no use. Give it back rather than hold it.
      if (worker.boxStatus === "paused") await box.resume()
      return { worker, box, runLabel }
    } catch (error) {
      log(`Could not claim worker ${worker.id} (${error.message}). Trying another.`)
      // Only this run's own labels are taken back. `busy` is only ever added
      // by the run that holds the Box, which here is this run.
      if (labelled) {
        await box.labels.remove(busy).catch(() => {})
        await box.labels.remove(runLabel).catch(() => {})
      }
      await backOff()
    }
  }
  return null
}

// `busy` goes first and the run label last. While the run label is there no
// other run can claim the Box, so a new owner's `busy` is never removed by us.
export async function releaseWorker(config, claim) {
  const { box, runLabel, worker } = claim
  try {
    await box.labels.remove(config.factory.busyLabel)
    await box.pause().catch((error) => console.error(`Could not pause ${worker.id}: ${error.message}`))
    await box.labels.remove(runLabel)
    console.log(`Released worker ${worker.id} and paused its Box.`)
  } catch (error) {
    console.error(`Could not fully release worker ${worker.id}: ${error.message}. Run scripts/recover-run.mjs or scripts/release-worker.mjs.`)
  }
}

// Moves bytes into and out of a Box through the files API, in chunks, and
// checks the SHA-256 on both ends, so a broken transfer fails loudly instead of
// becoming a wrong checkout or a wrong patch.
const CHUNK = 3 * 1024 * 1024
const sha256 = async (bytes) => (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")
const boxSha = async (box, path) => /^[0-9a-f]{64}/.exec((await sh(box, `sha256sum ${q(path)}`)).output)?.[0]

export async function uploadBytes(box, path, bytes) {
  const parts = []
  for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
    const part = `${path}.part-${String(i).padStart(5, "0")}`
    await box.files.write({ path: part, content: bytes.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64"), encoding: "base64" })
    parts.push(part)
  }
  await sh(box, `cat ${parts.map(q).join(" ")} > ${q(path)} && rm -f ${parts.map(q).join(" ")}`)
  if ((await boxSha(box, path)) !== (await sha256(bytes))) throw new Error(`Upload of ${path} into the Box arrived damaged (checksum mismatch).`)
}

// `maxBytes` stops a runaway file (an agent that wrote gigabytes) before it is read.
export async function downloadBytes(box, path, { maxBytes = 50 * 1024 * 1024 } = {}) {
  const size = Number((await sh(box, `wc -c < ${q(path)}`)).output.trim())
  if (!Number.isFinite(size) || size > maxBytes) throw new Error(`${path} in the Box is ${size} bytes, more than the ${maxBytes} the factory accepts. The change is too large to be a reviewable pull request.`)
  const chunks = []
  for (let offset = 0; offset < size; offset += CHUNK) {
    chunks.push(Buffer.from(await box.files.read(path, { encoding: "base64", offset, length: Math.min(CHUNK, size - offset) }), "base64"))
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.length !== size || (size > 0 && (await sha256(bytes)) !== (await boxSha(box, path)))) throw new Error(`Download of ${path} from the Box arrived damaged (checksum mismatch).`)
  return bytes
}
