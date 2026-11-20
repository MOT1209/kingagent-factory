// Small pure checks that keep a factory run safe. They live apart from run.mjs
// so the tests can reach them without a Box or a GitHub token.
import { classifyProviderError } from "./core/providers.mjs"

// Every commit the factory pushes carries this trailer. A branch whose head
// commit lacks it was pushed by a person, and the factory must not overwrite it.
export const FACTORY_TRAILER = "Factory-Run:"

export const factoryCommitMessage = (title, issueNumber, runId) => `${title}\n\nCloses #${issueNumber}\n\n${FACTORY_TRAILER} ${runId}`

export const isFactoryCommit = (message) => new RegExp(`^${FACTORY_TRAILER} \\S+\\s*$`, "m").test(String(message ?? ""))

// Paths the agent is told not to touch. The factory checks the staged change
// against them instead of trusting the agent to obey.
//   .github/          workflows and the settings that decide who may merge. Matched
//                     case-insensitively, so a checkout on a case-insensitive disk
//                     cannot be steered into it with ".GitHub/".
//   CODEOWNERS        at the root or in docs/, where GitHub also looks for it: it
//                     decides whose review a change needs.
//   .git anywhere     git's own folder. git apply refuses it already; this is the
//                     second lock on the same door.
const PROTECTED = [/^\.github\//i, /^(docs\/)?CODEOWNERS$/i, /(^|\/)\.git(\/|$)/i]
export const protectedPaths = (files) => files.filter((file) => PROTECTED.some((pattern) => pattern.test(file)))

// Replaces every known secret value in a text with ***. Values shorter than 8
// characters are skipped, because masking "true" or "1" would garble the output
// without protecting anything.
export function makeRedactor(values) {
  const secrets = [...new Set(values.filter((v) => typeof v === "string" && v.length >= 8))]
  // Multi-line secrets (an auth.json) are also masked line by line, since logs
  // often show only part of them.
  for (const value of [...secrets]) {
    if (value.includes("\n")) secrets.push(...value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 8))
  }
  secrets.sort((a, b) => b.length - a.length)
  return (text) => secrets.reduce((out, secret) => out.replaceAll(secret, "***"), String(text ?? ""))
}

// Comments are put into the agent's prompt. On a public repo anyone can comment,
// so only the people who may start the factory are heard.
export function trustedComments(comments, allowedActors) {
  const allowed = new Set(allowedActors.map((a) => a.toLowerCase()))
  return comments.filter((c) => c.author && allowed.has(c.author.toLowerCase()))
}

// Output of an agent that failed because of the provider, not because of the
// task: a usage or rate limit, an overloaded service, a dropped connection.
// Another agent type may well succeed where the same task cannot fail again
// for the same reason. A real code or test failure never matches. The typed
// kinds live in core/providers.mjs (docs/architecture/15 §4).
export const isTransientAgentFailure = (text) => classifyProviderError(text)?.transient === true

// --- the shape of a change -------------------------------------------------
// The host decides, from the staged diff, whether a change is reasonable to put
// in front of a reviewer. These are cheap guards against a runaway agent, not a
// judgement of quality.
export const DEFAULT_LIMITS = { maxFiles: 100, maxChangedLines: 5000 }

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$/

// Returns { refuse, flags }. `refuse` is a sentence (or null) that stops the push;
// `flags` are notes for the pull request's description.
export function reviewChange(changes, limits = {}) {
  const { maxFiles, maxChangedLines } = { ...DEFAULT_LIMITS, ...limits }
  const flags = []
  const total = changes.reduce((sum, c) => sum + (c.added ?? 0) + (c.deleted ?? 0), 0)

  if (changes.length > maxFiles) return { refuse: `The change touches ${changes.length} files, more than the ${maxFiles} the factory accepts for one pull request. Split the issue into smaller ones.`, flags }
  if (total > maxChangedLines) return { refuse: `The change adds or removes ${total} lines, more than the ${maxChangedLines} the factory accepts for one pull request. Split the issue into smaller ones.`, flags }
  if (changes.length > 0 && changes.every((c) => LOCKFILE.test(c.file))) return { refuse: "The change only touches lockfiles, which is not a change anyone asked for.", flags }

  const removedTests = changes.filter((c) => c.status === "D" && TEST_FILE.test(c.file))
  if (changes.length > 0 && removedTests.length === changes.length) return { refuse: "The change only deletes test files. Deleting tests is not a way to make checks pass.", flags }
  if (removedTests.length) flags.push(`Deletes ${removedTests.length} test file(s): ${removedTests.slice(0, 10).map((c) => `\`${c.file}\``).join(", ")}. Check that this is intended.`)
  if (changes.some((c) => LOCKFILE.test(c.file)) && changes.length > 1) flags.push("Changes a lockfile together with code. Check the dependency changes.")
  return { refuse: null, flags }
}
