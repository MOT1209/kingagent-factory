import { test } from "node:test"
import assert from "node:assert/strict"
import { ADAPTERS, verdict, modelMatches, SAFE_MODEL } from "../src/core/probe.mjs"
import { withModel } from "../src/agents.mjs"
import { resolveModel } from "../src/core/router.mjs"

// Shapes as the CLIs printed them in the 2026-11-21 probe (values shortened).
const claudeReport = (model, result = "PROBE OK") => JSON.stringify({ type: "result", result, modelUsage: { [model]: { inputTokens: 3, outputTokens: 5 } } })
const opencodeReport = ({ text = "PROBE OK", used = ["opencode", "big-pickle"], requested = used } = {}) =>
  [
    JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", tokens: { total: 7 } } }),
    "----- opencode export -----",
    JSON.stringify({ info: { id: "ses_1" }, messages: [
      { info: { role: "user", model: { providerID: requested[0], modelID: requested[1] } } },
      { info: { role: "assistant", providerID: used[0], modelID: used[1] } },
    ] }, null, 2),
  ].join("\n")

test("claude: the reply and the model come from --output-format json", () => {
  assert.deepEqual(ADAPTERS.claude.parse(claudeReport("claude-sonnet-5-5")), { reply: "PROBE OK", modelsUsed: ["claude-sonnet-5-5"] })
  assert.match(ADAPTERS.claude.command, /--model \{model\}/)
})

test("opencode: the reply comes from text events, the model only from assistant messages of the export", () => {
  assert.deepEqual(ADAPTERS.opencode.parse(opencodeReport()), { reply: "PROBE OK", modelsUsed: ["opencode/big-pickle"] })
  // The user message asked for one model and another answered: only the answering one counts.
  const swapped = ADAPTERS.opencode.parse(opencodeReport({ used: ["opencode", "other"], requested: ["opencode", "big-pickle"] }))
  assert.deepEqual(swapped.modelsUsed, ["opencode/other"])
  assert.match(ADAPTERS.opencode.command, /exit \$rc$/)
})

test("an alias matches the full id the CLI reports; a different model does not", () => {
  assert.ok(modelMatches("sonnet", "claude-sonnet-5-5"))
  assert.ok(modelMatches("opencode/big-pickle", "opencode/big-pickle"))
  assert.ok(!modelMatches("sonnet", "claude-haiku-5-5"))
  assert.ok(!modelMatches("son", "claude-sonnet-5-5"))
})

test("verdict: verified only when the round-trip passed and the CLI names the requested model", () => {
  const ok = { requested: "sonnet", code: 0, reply: "PROBE OK", modelsUsed: ["claude-sonnet-5-5"] }
  assert.deepEqual(verdict(ok), { status: "verified" })
  assert.match(verdict({ ...ok, code: 1 }).reason, /exit code 1/)
  assert.match(verdict({ ...ok, reply: "hello" }).reason, /not exactly PROBE OK/)
  assert.equal(verdict({ ...ok, reply: "I cannot comply with PROBE OK" }).status, "failed")
  assert.equal(verdict({ ...ok, reply: "  PROBE OK\n" }).status, "verified")
  assert.match(verdict({ ...ok, modelsUsed: [] }).reason, /did not report/)
  assert.match(verdict({ ...ok, modelsUsed: ["claude-haiku-5-5"] }).reason, /asked for sonnet, the CLI reports claude-haiku-5-5/)
  assert.match(verdict({ ...ok, error: "the CLI help does not list --model" }).reason, /--model/)
})

test("model ids are plain: nothing that could break out of the quoted command", () => {
  for (const id of ["haiku", "opencode/big-pickle", "claude-sonnet-5-5", "a.b:c@d"]) assert.ok(SAFE_MODEL.test(id), id)
  for (const id of ["x'; rm -rf ~", "a b", "$(id)", "`id`", "", "x".repeat(101)]) assert.ok(!SAFE_MODEL.test(id), id)
})

test("withModel puts the flag and the quoted model right after the binary, and refuses what it cannot render", () => {
  const agent = { command: 'claude -p "$(cat {prompt})" > {summary}', modelFlag: "--model" }
  assert.equal(withModel(agent), agent.command)
  assert.equal(withModel(agent, "sonnet"), `claude --model 'sonnet' -p "$(cat {prompt})" > {summary}`)
  const opencode = { command: 'opencode run {model} "$(cat {prompt})"', modelFlag: "-m" }
  assert.equal(withModel(opencode, "opencode/big-pickle"), `opencode run -m 'opencode/big-pickle' "$(cat {prompt})"`)
  assert.equal(withModel(opencode), 'opencode run "$(cat {prompt})"')
  assert.throws(() => withModel({ command: "claude" }, "sonnet"), /no modelFlag/)
  assert.throws(() => withModel(agent, "x'; id"), /not a model id/)
})

test("resolveModel can be limited to one provider", () => {
  const registry = { tiers: { balanced: [{ provider: "claude", model: "sonnet", status: "verified" }, { provider: "opencode", model: "opencode/x", status: "verified" }] } }
  assert.equal(resolveModel(registry, "balanced", { provider: "opencode" }).model, "opencode/x")
  assert.equal(resolveModel(registry, "balanced", { provider: "codex" }).ok, false)
})
