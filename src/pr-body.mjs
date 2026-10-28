// The pull request description, built from facts the host knows. The agent's own
// summary is included but cut and masked by the caller; everything else here is
// the factory's, so a reviewer can tell the two apart.
const MAX_FILES_LISTED = 30

export function buildPrBody({ issueNumber, summary, workerId, agent, checks = [], runUrl, changes = [], flags = [] }) {
  const files = changes.length
    ? ["", "## Files", ...changes.slice(0, MAX_FILES_LISTED).map((c) => `- \`${c.file}\` (${c.status === "A" ? "added" : c.status === "D" ? "deleted" : "changed"}${c.added === null ? ", binary" : `, +${c.added} -${c.deleted}`})`), ...(changes.length > MAX_FILES_LISTED ? [`- ...and ${changes.length - MAX_FILES_LISTED} more`] : [])].join("\n")
    : ""
  const notes = flags.length ? ["", "## For the reviewer", ...flags.map((f) => `- ${f}`)].join("\n") : ""
  const checkLine = checks.length ? `Checks passed: ${checks.map((c) => `\`${c}\``).join(", ")}.` : "This repo has no automated checks."
  return `Closes #${issueNumber}\n\n${summary || "(The agent gave no summary.)"}\n${files}${notes}\n\n---\nBuilt by factory worker \`${workerId}\` (${agent}) in an Upstash Box. ${checkLine}${runUrl ? ` [Factory run](${runUrl}).` : ""}`
}
