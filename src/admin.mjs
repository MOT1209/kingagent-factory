// Small pure helpers for the operator scripts (set-secrets, install-trigger).
// They live here so the tests can reach them without gh, git or the network.

// `--only owner/name[,owner/name]` (or `--only=owner/name`) limits a script to
// some of the repos in factory.config.json. Without it every repo is used.
// Names are compared without regard to case, as GitHub does. An unknown name is
// an error, so a typo can never mean "all repos" or "no repos" by accident.
export function selectRepos(repos, argv = []) {
  const wanted = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--only") wanted.push(...String(argv[++i] ?? "").split(","))
    else if (arg.startsWith("--only=")) wanted.push(...arg.slice("--only=".length).split(","))
  }
  const asked = argv.some((a) => a === "--only" || a.startsWith("--only="))
  const names = wanted.map((n) => n.trim()).filter(Boolean)
  if (asked && names.length === 0) throw new Error("--only needs one or more owner/name values, separated by commas")
  if (names.length === 0) return { repos, only: false }

  const unknown = names.filter((n) => !repos.some((r) => r.repo.toLowerCase() === n.toLowerCase()))
  if (unknown.length) throw new Error(`--only names repos that are not in factory.config.json: ${unknown.join(", ")}`)
  const chosen = new Set(names.map((n) => n.toLowerCase()))
  return { repos: repos.filter((r) => chosen.has(r.repo.toLowerCase())), only: true }
}

// What a flaky connection looks like in gh or git output. A permission error
// or a missing repo is not in this list: asking again does not fix those.
export const isTransientCliFailure = (text) =>
  /TLS handshake timeout|i\/o timeout|timed out|connection (reset|refused|closed)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|unexpected EOF|\b(502|503|504)\b|temporarily unavailable/i.test(String(text ?? ""))

// Runs `fn` up to `attempts` times, waiting between tries, but only when the
// failure looks transient. `sleep` is injectable so tests do not wait.
export function withRetry(fn, { attempts = 3, delayMs = 3000, isTransient = isTransientCliFailure, sleep = sleepSync, log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      if (attempt >= attempts || !isTransient(error.message)) throw error
      const wait = delayMs * attempt
      log(`  transient failure (${String(error.message).split("\n")[0].slice(0, 120)}); retrying in ${Math.round(wait / 1000)}s (${attempt}/${attempts - 1})`)
      sleep(wait)
    }
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
