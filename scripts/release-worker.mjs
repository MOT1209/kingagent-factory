// Frees a worker that is stuck as busy. That happens when a factory run is
// cancelled or crashes before it can release its Box, and the automatic sweep
// (scripts/reap-stale.mjs) could not tell that its run was finished.
//
// Before touching anything it asks GitHub whether the run that holds the
// worker is still going, and refuses if it is, or if it cannot tell, unless
// --force is given. A run started from someone's machine cannot be checked.
//
// Run with: node --env-file=.env scripts/release-worker.mjs <worker id> [--force]
import { Box } from "@upstash/box"
import { loadConfig } from "../src/config.mjs"
import { getWorkerStates } from "../src/workers.mjs"
import { isRunLabel } from "../src/box.mjs"
import { cleanAndFree } from "../src/recover.mjs"
import { getWorkflowRun } from "../src/github.mjs"

const config = loadConfig()
const force = process.argv.includes("--force")
const worker = (await getWorkerStates(config)).find((w) => w.id === process.argv[2])
if (!worker?.boxId) throw new Error("Usage: release-worker.mjs <worker id> [--force] (the worker must have a Box)")

const box = await Box.get(worker.boxId)
const runs = (await box.labels.list()).filter(isRunLabel)
for (const label of runs) {
  const id = /^run-(\d+)$/.exec(label)?.[1]
  const run = id && process.env.FACTORY_GITHUB_TOKEN ? await getWorkflowRun(config.factory.repo, id).catch(() => null) : null
  if (run && run.status !== "completed") {
    if (!force) throw new Error(`${label}: run ${id} is still ${run.status} (${run.html_url}). It owns this worker. Cancel it first, or pass --force.`)
    console.log(`${label}: run ${id} is still ${run.status}. Releasing anyway (--force).`)
  } else if (!run && !force) {
    throw new Error(`${label}: cannot tell whether this run is still going (${id ? "the token may not read Actions runs" : "it was started outside GitHub Actions"}). Check the Actions tab or the machine that started it, then pass --force.`)
  } else if (run) {
    console.log(`${label}: run ${id} is ${run.status} (${run.conclusion}).`)
  }
}

// Clean up first (and check it) and free the worker last, so no new run can
// claim the Box while its sign-in folder is being deleted. A Box that still holds
// the last job's files is not freed.
const { freed, left } = await cleanAndFree(config, box, { paused: worker.boxStatus === "paused", labels: runs })
if (!freed) {
  console.error(`The Box could not be cleaned (${left.join(", ")}), so it was NOT freed. Fix it by hand (for example delete the Box and run provision-workers.mjs), then run this again.`)
  process.exit(1)
}
console.log(`Removed sign-in and work files. Worker ${worker.id} is free and its Box is paused.`)
