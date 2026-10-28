# Stage 10: development pass

Follows stage 9. Same limits: no credentials in this session, so everything here
is verified by local tests (real shell, git and processes; Box and GitHub are
stand-ins). Nothing below has run against Upstash or GitHub's Factory workflow.

## Added

| Area | What |
|---|---|
| Reliability | `release-worker.mjs` cleans through the verified path (`cleanAndFree`) and refuses to free a dirty Box. Scheduled sweep `reap.yml` (read-only, every 3 h). Dependabot for Actions and npm. |
| Fallback | A provider limit (usage/rate limit, overload) moves the issue once to a worker of another agent type, only if a shorter second pass fits `runBudgetMinutes`; never for `agent:<name>` issues. `check-setup.mjs` checks the budget against the workflow limit. |
| Output quality | Host-side change review (`reviewChange`): file and line limits per repo, lockfile-only and test-deletion-only changes refused, notes in the PR. Structured PR body (`buildPrBody`) with measured file list. `NEEDS_SPLIT:` reply for oversized tasks. |
| Speed | Waiting runs poll every 10-15 s with jitter instead of 30 s. |
| Operator | Job summary and `factory-stats` line per run. `status.mjs --json` with stale-claim detection and advice. `doctor.mjs`. `report.mjs` totals usage from logs. README runbook. |

## Tests

`npm run check`: **165 tests, 165 passing**, 3 runs in a row (Node 22.22.0, local).
New tests cover each row above, including: fallback happy path with
both Boxes clean and no secret left, no fallback for a real failure / forced
agent / exhausted budget / single agent type, second pass with no free worker
handing the issue to a person, a continuing pass refusing an issue another run
owns, the second pass's wait cap and missing check retry, change-shape limits
with real `git diff` output, workflow files (least privilege, no secret blob).

## Not done

- **Dependency cache in the worker** (planned for stage 10). It would put build
  output on a persistent Box disk next to a later job's code and the agent's
  tools, which cuts against the cleanup guarantees from stage 9. It needs a
  design for isolation (a cache keyed by lockfile hash, read-only for the
  agent, verified like `scrubBox`), and a real Box to measure the gain. Left
  out rather than guessed.
- **Dependabot only proposes updates.** Actions are still on major tags until
  someone changes each `uses:` to a SHA once.
- **Everything needing real services** (see stage 9): dry run, end-to-end run,
  real agents, the new fallback and sweep on real infrastructure.
