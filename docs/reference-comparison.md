# Reference comparison: cubefarm and codeden

Source: shallow reads of `leonvanzyl/cubefarm` and `leonvanzyl/codeden` (public, MIT). Files read: cubefarm `server/qaPrompt.ts`, `server/mergeGate.ts`; codeden `apps/server/src/services/factory/` (file list, `agent-choice.ts`). The rest is from their READMEs. Nothing here was run.

## What each does that the factory does not

| Idea | Where | Factory today |
|---|---|---|
| QA agent tests each PR, re-tests only what changed since last round | cubefarm `qaPrompt.ts` | Runs configured check commands only, one retry |
| Pure merge-gate state machine: wait / re-run failed checks once per head / send back / update branch / merge, with a fix budget (5) and slow-check alert (30 min) | cubefarm `mergeGate.ts` | Never merges (by design) |
| Per-role provider/model routing (builder, docs builder, scout, reviewer) and waiting when no provider is available | codeden `agent-choice.ts`, `availability.ts`, `provider-backoffs.ts` | Fallback to the other agent type on a provider limit |
| Usage ledger and per-item cost/budget | codeden `usage_ledger`, `item-budget.ts`, `item-cost.ts` | Run summary only |
| Lessons carried between runs | codeden `lessons.ts` | None |
| Browser QA with screenshots (Playwright, Chrome) | cubefarm README | None |

## What not to copy

Both let agents run unsandboxed with self-approved tool calls, and both can auto-merge. The factory keeps its own rules: the agent runs in an isolated Box with no GitHub token, the runner pushes, and a person merges.

## Proposed next stage (after the first successful real PR)

1. **Review-only QA step.** After the PR opens, a second Box job checks out the PR head, starts the app, and runs a Playwright smoke test. It posts findings as a PR comment with screenshots. It cannot merge or push.
2. **Re-test scoping.** Port the idea in `qaPrompt.ts`: on a retry, test the diff since the last tested commit.
3. **Per-role routing in `factory.config.json`** (builder, reviewer), with a wait instead of a failure when both agents are limited.
4. **Cost line in the run summary** if the Box SDK exposes usage.
5. Auto-merge stays off. If ever wanted, take the shape of `mergeStep` (pure function, tested) and require a human label.
