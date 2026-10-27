// A stand-in for an Upstash Box that runs everything for real on this machine:
// the same shell commands, background scripts, git and files the factory uses
// in a Box. Box paths (/workspace/home, /home/boxuser) are mapped into a temp
// folder, so nothing outside it is touched.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"

export function localBox({ root, id = "local-box", name = "kaf-claude-01", labels = [] }) {
  const home = `${root}/home`
  mkdirSync(home, { recursive: true })
  const map = (text) => String(text).replaceAll("/workspace/home", home).replaceAll("/home/boxuser", `${root}/boxuser`)
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  const box = {
    id,
    name,
    status: "paused",
    root,
    home,
    labelSet: new Set(labels),
    commands: [],
    path: map,
    labels: {
      add: async (label) => {
        await tick()
        if (box.labelSet.size >= 5 && !box.labelSet.has(label)) throw new Error("a Box holds at most 5 labels")
        box.labelSet.add(label)
      },
      remove: async (label) => void (await tick(), box.labelSet.delete(label)),
      list: async () => (await tick(), [...box.labelSet]),
    },
    resume: async () => void (box.status = "running"),
    pause: async () => void (box.status = "paused"),
    exec: {
      command: async (command) => {
        box.commands.push(command)
        const r = spawnSync("sh", ["-c", map(command)], { cwd: home, env: { PATH: process.env.PATH, HOME: home, LANG: "C" }, encoding: "utf8" })
        return { status: r.status === 0 ? "completed" : "failed", result: `${r.stdout}${r.stderr}` }
      },
    },
    files: {
      write: async ({ path, content, encoding }) => {
        const file = map(path)
        mkdirSync(dirname(file), { recursive: true })
        // Scripts name Box paths too, so text is mapped like commands are.
        writeFileSync(file, encoding === "base64" ? Buffer.from(content, "base64") : map(content))
      },
      read: async (path, { encoding, offset = 0, length } = {}) => {
        const bytes = readFileSync(map(path))
        const slice = bytes.subarray(offset, length === undefined ? undefined : offset + length)
        return encoding === "base64" ? slice.toString("base64") : slice.toString("utf8")
      },
    },
    exists: (path) => existsSync(map(path)),
  }
  return box
}
