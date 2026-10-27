// factory.yml hands each secret to the steps by name, so a secret that
// factory.config.json needs but the workflow does not pass would only show up
// as a failed run. These tests catch it earlier, and keep the "all secrets in
// one blob" pattern out of the workflow.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { realConfig } from "./helpers.mjs"

const workflow = readFileSync(new URL("../.github/workflows/factory.yml", import.meta.url), "utf8")

// The text of one step, from its "- name:" line to the next one.
const step = (name) => {
  const start = workflow.indexOf(`- name: ${name}`)
  assert.ok(start >= 0, `step "${name}" exists`)
  const next = workflow.indexOf("\n      - ", start + 1)
  return workflow.slice(start, next < 0 ? undefined : next)
}

test("no step dumps every secret into the environment", () => {
  assert.doesNotMatch(workflow, /toJSON\(\s*secrets\s*\)/)
})

test("the plan and work steps pass every secret the config names", () => {
  const config = realConfig()
  const needed = new Set(["UPSTASH_BOX_API_KEY", "FACTORY_GITHUB_TOKEN"])
  for (const agent of Object.values(config.agents)) for (const entry of agent.auth ?? []) needed.add(entry.secret)
  for (const repo of config.repos) for (const entry of repo.secrets ?? []) needed.add(entry.secret)

  for (const name of ["Show the plan", "Do the work and open a pull request"]) {
    const text = step(name)
    for (const secret of needed) {
      assert.match(text, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`), `"${name}" passes ${secret}`)
    }
  }
})

test("npm ci never sees a secret", () => {
  const start = workflow.indexOf("- run: npm ci")
  const next = workflow.indexOf("\n      - ", start + 1)
  assert.doesNotMatch(workflow.slice(start, next), /secrets\./)
})
