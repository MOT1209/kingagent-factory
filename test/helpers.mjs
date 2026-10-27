// Shared test fixtures: a valid config on disk and in-memory Boxes.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../src/config.mjs"

export const realConfig = () => JSON.parse(readFileSync(new URL("../factory.config.json", import.meta.url), "utf8"))

// Writes a (changed) config to a temp folder and loads it like the factory does.
export function load(mutate = () => {}) {
  const raw = realConfig()
  mutate(raw)
  const dir = mkdtempSync(join(tmpdir(), "factory-test-"))
  const file = join(dir, "factory.config.json")
  writeFileSync(file, JSON.stringify(raw))
  return loadConfig(pathToFileURL(file))
}

export const loadError = (mutate) => {
  try {
    load(mutate)
  } catch (error) {
    return error.message
  }
  throw new Error("expected loadConfig to throw")
}

// A Box with the label API the factory uses, and the Upstash limit of five.
export function fakeBox({ id, name, labels = [], status = "paused" }) {
  const box = {
    id,
    name,
    status,
    labelSet: new Set(labels),
    commands: [],
    labels: {
      add: async (label) => {
        await tick()
        if (box.labelSet.size >= 5 && !box.labelSet.has(label)) throw new Error("a Box holds at most 5 labels")
        box.labelSet.add(label)
      },
      remove: async (label) => {
        await tick()
        box.labelSet.delete(label)
      },
      list: async () => (await tick(), [...box.labelSet]),
    },
    resume: async () => void (box.status = "running"),
    pause: async () => void (box.status = "paused"),
    exec: {
      command: async (command) => (box.commands.push(command), { status: "completed", result: "__EXIT__0" }),
    },
  }
  return box
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// Records label changes on an issue and keeps its current label set.
export function fakeGithub(initial = [], comments = []) {
  const issue = { labels: new Set(initial), comments: [] }
  return {
    issue,
    getIssue: async () => ({ state: "open", labels: [...issue.labels].map((name) => ({ name })) }),
    addLabels: async (_repo, _n, labels) => labels.forEach((l) => issue.labels.add(l)),
    removeLabel: async (_repo, _n, label) => void issue.labels.delete(label),
    comment: async (_repo, _n, body) => void issue.comments.push(body),
    listComments: async () => [...comments, ...issue.comments.map((body) => ({ author: "MOT1209", body: `${body}\n<!-- software-factory -->` }))],
  }
}
