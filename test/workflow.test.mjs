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

// --- the scheduled sweep (reap.yml) ---
const reap = readFileSync(new URL("../.github/workflows/reap.yml", import.meta.url), "utf8")

test("reap.yml is read-only for the repo, keeps no checkout token, and npm ci sees no secret", () => {
  assert.match(reap, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/)
  assert.match(reap, /persist-credentials: false/)
  const start = reap.indexOf("- run: npm ci")
  assert.doesNotMatch(reap.slice(start, reap.indexOf("\n      - name:", start)), /secrets\./)
  assert.doesNotMatch(reap, /toJSON\(\s*secrets\s*\)/)
})

test("reap.yml passes the two secrets the sweep needs and runs only the sweep", () => {
  for (const secret of ["UPSTASH_BOX_API_KEY", "FACTORY_GITHUB_TOKEN"]) assert.match(reap, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`))
  assert.match(reap, /node scripts\/reap-stale\.mjs/)
  assert.doesNotMatch(reap, /src\/run\.mjs/)
})

test("reap.yml has a schedule, a time limit and no overlapping sweeps", () => {
  assert.match(reap, /schedule:\s*\n\s*- cron: "/)
  assert.match(reap, /timeout-minutes: \d+/)
  assert.match(reap, /concurrency:\s*\n\s*group: reap-stale/)
})

test("dependabot watches Actions and npm", () => {
  const d = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8")
  assert.match(d, /package-ecosystem: github-actions/)
  assert.match(d, /package-ecosystem: npm/)
})

test("both Claude workflows start only for allowed actors, and CI audits dependencies", () => {
  for (const f of ["claude.yml", "claude-code-review.yml"]) {
    assert.match(readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8"), /contains\(fromJSON\('\["MOT1209"\]'\), github\.actor\)/, f)
  }
  assert.match(readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"), /npm audit --omit=dev --audit-level=high/)
})
