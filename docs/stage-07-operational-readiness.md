# Stage 7 — operational readiness audit and fixes

Audited against the code on `main` at `ac5916d` and against GitHub. The
factory repo had **0 workflow runs** at the time (`GET .../actions/runs` →
`total_count: 0`), so nothing in this stage could be checked against a real
run. No secret value was read, and no Box, agent or GitHub write was used.

## Confirmed blockers (need the owner)

1. **The token cannot dispatch or push.** Stage 5 recorded `Contents` write →
   403 on KingAgent. `POST /repos/.../dispatches` (the trigger) and the
   branch push in `run.mjs` both need Contents write, so the first real run
   would fail at the trigger and again at the push.
2. **`rashid-hq-os` is not in the token's selection** (label write → 403).
3. **No Actions secrets anywhere.** `set-secrets.mjs` never ran: it needs the
   owner's own `gh` sign-in with admin rights. KingAgent's trigger is on `main`
   but has no `FACTORY_GITHUB_TOKEN`, so it fails before it calls the factory.
4. **`FACTORY_DRY_RUN` is not set**, same reason. It must be `true` before the
   first test issue.
5. **Claude has never completed a run** (weekly limit in Stage 4).

## Bugs and risks found in the code, and what changed

| # | Problem | Fix |
| --- | --- | --- |
| 1 | A run killed by the workflow limit or a cancel skipped its `finally`: worker stuck busy, **sign-in files left on the paused Box's disk**, issue stuck on `factory:running`. | `src/recover.mjs` + `scripts/recover-run.mjs`, run by a new workflow step on `failure() \|\| cancelled()`. The work step has its own 165-minute limit, so the step still runs inside the job's 175. |
| 2 | `factory.yml` put every secret (`toJSON(secrets)`) in the job env, so `npm ci` install scripts could read the tokens. `checkout` also kept its token in `.git`. | Secrets moved to the steps that need them; `persist-credentials: false`. |
| 3 | Comments from **any** GitHub user went into the agent's prompt. | Only `allowedActors` are heard (`trustedComments`). |
| 4 | The branch was pushed with `--force`, so a re-run would destroy commits a person pushed to `factory/issue-<n>`. | The run inspects the branch first; a head without the `Factory-Run:` trailer stops the run. The push uses `--force-with-lease` against the SHA seen. Tested against real git in `test/push-lease.test.mjs`. |
| 5 | A duplicate event or a manual run next to a label run could take the same issue. | A run that sees `factory:running` stands down; after waiting for a worker it reads the issue again. |
| 6 | A claimer working from a seconds-old worker list could join a Box another run had already passed its rival check on. | Claim skips any Box that already has `busy` or a `run-` label. `claimWorker` takes injectable deps so the race is tested. |
| 7 | Label transitions were hand-written per path; a failure after a re-run could leave `factory:review` next to `factory:needs-attention`. | `src/issue-state.mjs`: each outcome sets one factory label and removes the other three. |
| 8 | When Claude failed, its error (written to `{summary}` by the `>` redirect) was not shown; the comment showed an empty log. | The comment shows summary and log. |
| 9 | Only the GitHub token was masked in comments. | Every known secret value is masked, multi-line ones line by line. |
| 10 | An agent that committed anyway looked like "no files changed". | Its commits are folded back with `git reset --soft <base>`. |
| 11 | "Do not touch `.github/`" was only a request. | Enforced: such changes are never pushed. |
| 12 | A missing agent sign-in was found only after the repo setup had run. | Checked right after the claim; the dry run warns too. |
| 13 | Config validation missed label clashes (a busy label starting with `run-` would break claiming), unsafe branch prefixes, bad timeouts, no enabled worker. | Added to `loadConfig`. |
| 14 | `check-setup` could not tell whether a trigger was installed. | It reads each app repo's default branch for the trigger. |
| 15 | The prompt said nothing about the repo's own `AGENTS.md`/`CLAUDE.md`. | It now tells the agent to follow them unless they contradict the factory rules. |

Left as they were, and documented in the README: the token in the clone URL
during clone, branch check and push (the agent is not running then); a race
that could create two Boxes with one name if no Box exists yet; no automatic
detection of a stale `busy` label (the token has no Actions permission).

## Tests

`npm test`, 37 tests, all passing on Node 22.22.0: config validation, worker
selection, the claim race (two claimers, one worker, exactly one wins),
label transitions, recovery, the guards, and the push lease against real git.
`.github/workflows/test.yml` runs `npm run check` on every push.

Not executed: anything that needs the Upstash key, the GitHub token or an
agent, so no smoke test, no dry run through GitHub and no end-to-end run.
