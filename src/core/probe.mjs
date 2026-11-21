// Pure parts of the capability probe (scripts/probe-models.mjs, docs 15 §6,
// risk R-36): how each CLI takes a model and reports the one it used, and the
// verdict. No I/O, so the rules that decide "verified" are tested without a Box.

const EXPORT_MARK = "----- opencode export -----"

// {prompt}, {summary} and {model} are filled in by the probe; {model} arrives
// already single-quoted. Only agent types listed here can be probed.
export const ADAPTERS = {
  claude: {
    binary: "claude",
    help: "claude --help",
    flag: "--model",
    command: `claude -p "$(cat {prompt})" --model {model} --output-format json --dangerously-skip-permissions > {summary}`,
    // --output-format json prints one object: { result, modelUsage: { <model id>: {...} }, ... }.
    parse(summary) {
      const report = JSON.parse(summary)
      return { reply: String(report.result ?? ""), modelsUsed: Object.keys(report.modelUsage ?? {}) }
    },
  },
  opencode: {
    binary: "opencode",
    help: "opencode run --help",
    flag: "--model",
    // `run --format json` prints JSON events without the model, so the session
    // is exported after the run; the run's own exit code is kept.
    command: [
      `opencode run -m {model} --format json "$(cat {prompt})" > {summary}; rc=$?`,
      `s=$(grep -o '"sessionID":"[^"]*"' {summary} | head -n 1 | cut -d '"' -f 4)`,
      `echo "${EXPORT_MARK}" >> {summary}`,
      `[ -n "$s" ] && opencode export "$s" >> {summary} 2>/dev/null`,
      `exit $rc`,
    ].join("\n"),
    // Reply: the text events. Models: only assistant messages of the export,
    // because the user message carries the requested model, not the one used.
    parse(summary) {
      const [events, exported = ""] = summary.split(EXPORT_MARK)
      const reply = events.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)).filter((e) => e.type === "text").map((e) => e.part?.text ?? "").join("\n")
      const session = JSON.parse(exported.slice(exported.indexOf("{")))
      const modelsUsed = [...new Set((session.messages ?? []).filter((m) => m.info?.role === "assistant" && m.info.providerID && m.info.modelID).map((m) => `${m.info.providerID}/${m.info.modelID}`))]
      return { reply, modelsUsed }
    },
  },
}

export const PROMPT = "Reply with exactly: PROBE OK"
export const SAFE_MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/

// A requested alias such as "sonnet" matches a reported id such as
// "claude-sonnet-4-5-20250929"; a full id must match itself.
export const modelMatches = (requested, used) => used === requested || used.split(/[-/]/).includes(requested)

// "verified" only when the round-trip passed AND the CLI's own report names a
// model matching the request. Everything else is "failed" with the reason.
export function verdict({ requested, code, reply = "", modelsUsed = [], error }) {
  if (error) return { status: "failed", reason: error }
  if (code !== 0) return { status: "failed", reason: `exit code ${code}` }
  // Exactly the reply asked for: a refusal that quotes "PROBE OK" must not pass.
  if (reply.trim() !== "PROBE OK") return { status: "failed", reason: "the reply was not exactly PROBE OK" }
  if (!modelsUsed.length) return { status: "failed", reason: "the CLI did not report which model it used" }
  if (!modelsUsed.some((m) => modelMatches(requested, m))) return { status: "failed", reason: `asked for ${requested}, the CLI reports ${modelsUsed.join(", ")}` }
  return { status: "verified" }
}
