// Small pure checks that keep a factory run safe. They live apart from run.mjs
// so the tests can reach them without a Box or a GitHub token.

// Every commit the factory pushes carries this trailer. A branch whose head
// commit lacks it was pushed by a person, and the factory must not overwrite it.
export const FACTORY_TRAILER = "Factory-Run:"

export const factoryCommitMessage = (title, issueNumber, runId) => `${title}\n\nCloses #${issueNumber}\n\n${FACTORY_TRAILER} ${runId}`

export const isFactoryCommit = (message) => new RegExp(`^${FACTORY_TRAILER} \\S+\\s*$`, "m").test(String(message ?? ""))

// Paths the agent is told not to touch. The factory checks the staged change
// against them instead of trusting the agent to obey.
const PROTECTED = [/^\.github\//]
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
