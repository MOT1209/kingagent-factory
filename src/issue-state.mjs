// The issue labels a run moves between. Each outcome is one transition, so the
// end state of an issue never depends on which code path got there.
//
//   ready ──claim──> running ──PR──> review
//                       └──error, check failure, timeout, cancel──> needs-attention
export function transitions(labels) {
  // Each outcome removes every other factory state, so an issue never shows two.
  const all = [labels.ready, labels.running, labels.review, labels.needsAttention]
  const to = (label) => ({ add: [label], remove: all.filter((l) => l !== label) })
  return { running: to(labels.running), review: to(labels.review), needsAttention: to(labels.needsAttention) }
}

// Adds before it removes, so the issue is never without a factory label while
// a run still owns it.
export async function applyTransition(api, repo, number, transition) {
  if (transition.add.length) await api.addLabels(repo, number, transition.add)
  for (const label of transition.remove) await api.removeLabel(repo, number, label)
}

// The label set after a transition. Used by the tests and by dry runs.
export const labelsAfter = (current, transition) => [...new Set([...current.filter((l) => !transition.remove.includes(l)), ...transition.add])]

// A second run for the same issue (a duplicate event, a manual run next to a
// label run) sees the first one's running label and stands down.
export const takenByAnotherRun = (issueLabels, labels) => issueLabels.includes(labels.running)
