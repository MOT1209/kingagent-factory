# Stage 8 — production-readiness pass

Audited `main` at `f4c446e` (Stage 7 merged). Baseline: `npm run check` gave 37
tests, all passing. GitHub still showed **0 runs of the Factory workflow**
(checked 2026-10-27), and this environment had no `.env`. So nothing below was
run against Upstash, GitHub's API or an agent; every result comes from local
tests.

## Audit

P0 blocks safe operation or the first end-to-end run. P1 is a reliability or
security fault. P2 is worth fixing but does not block a first run.

| Sev | Finding | Kind | Evidence | Done |
| --- | --- | --- | --- | --- |
| P0 | Token lacks Contents write (dispatch and push fail), `rashid-hq-os` not in its selection, no Actions secrets, `FACTORY_DRY_RUN` unset | external | Stage 5 (403s); 0 Factory runs | needs the owner |
| P1 | **GitHub token passed through the Box.** It was used in the clone URL and the push inside a Box whose user has passwordless sudo and whose disk persists between jobs. An agent could replace git, or plant a hook, and catch the token on that job's push or a later job's clone. The push also ran the repo's own git hooks, which the agent can write, with the token in the URL. | confirmed design defect | `run.mjs` used `authedUrl` in Box `sh` calls; Stage 6 shows passwordless sudo | git moved to the runner (`src/git-host.mjs`): tarball in, patch out |
| P1 | **The claim could give one worker to two runs.** Rule was "lower run id wins". A late claimer with a lower id, after a stalled request, kept the Box even though the first run had already passed its check. | confirmed logic defect | sequence analysis; old code `rivals.some(l => l < runLabel)` | add-then-list with both retreating; `busy` added only by the winner; tested with 4-way races |
| P1 | A Box that failed to wake after the claim stayed `busy` forever | confirmed | `resume()` ran after the labels and outside any cleanup | claim taken back on failure; tested |
| P1 | No stale-claim detection. A worker whose run died stayed busy until someone noticed. | confirmed | only manual `release-worker.mjs` | `reap-stale.mjs` before every run, acting only on runs GitHub reports `completed` |
| P1 | `release-worker.mjs` freed workers held by live runs without asking | confirmed | removed every `run-` label unconditionally | checks run status, refuses unless `--force` |
| P1 | Recovery could hand back an issue a newer run owned | confirmed | it flipped any `factory:running` issue | the pickup comment carries a run mark; only the owning run's recovery touches the issue |
| P1 | Job folder (prompt, logs, summary with anything the agent printed) left on the paused Box's disk | confirmed by a new test | `grepTree` found the agent secret in `.job/summary.md` | whole work folder deleted after every job |
| P1 | `cd` failure in a Box script was ignored, so the agent and the checks could run in the wrong folder | confirmed (bit the test harness itself) | script body `cd dir` with no check | `cd … \|\| exit 97` |
| P1 | No retry for rate limits or 5xx; every GitHub failure looked alike | confirmed | single `fetch`, generic message | bounded retries, writes never repeated after a possibly delivered request, per-status advice |
| P2 | Manual runs with a different spelling (`kingagent`, `07`) got their own concurrency slot | confirmed | the group key is the raw input | refused; `check-setup` checks the config uses GitHub's spelling |
| P2 | `check-setup` could not tell bad token / no permission / not visible / network apart, and could not test write access | confirmed | only `GET /repos` | `/user` check, classified errors, `--probe-writes` |
| P2 | A missing Box key was reported as "the key does not work" | confirmed | output | reported as missing |
| P1 | A rename out of `.github/` listed only the new path, so it passed the protected-path check | confirmed by a test that failed before the fix | `git diff --name-only` folds renames | `--no-renames` |
| P2 | No cap on the size of what comes back from the Box | suspected risk | — | 50 MB cap; PR text cut to 50,000 characters |
| P3 | `install-trigger.mjs` force-pushes its own `factory/install-trigger` branch | minor | — | left; it is the factory's own branch |

## Not changed, and why

- **Prompt injection.** It cannot be fixed by wording. The controls are the
  actor allowlist, trusted-only comments, the token kept out of the Box, the
  protected paths, and human review.
- **A process the agent leaves running in the Box** survives until the Box is
  paused. It cannot reach the GitHub token any more, but it does see the next
  job's code and the agent sign-in. Killing every `boxuser` process would also
  kill the Box's own service. This is documented, not fixed.
- **No new labels** for waiting, cancelled or timed out. They map onto the
  existing four (README, "Issue states"), so app repos need no label changes.

## Tests

`npm run check`: **92 tests, 92 passing, 0 failing** (Node 22.22.0, this
container). The suite before the last fix passed 4 runs in a row, which
checks the race and timing tests for flakiness. New coverage:

- **`test/pipeline.test.mjs`, 26 tests.** The real `runIssue` runs against a
  local Box: real shell, real background scripts, real process-group kills,
  real git. Local bare repos stand in for GitHub's git, and an in-memory API
  for GitHub's REST. Covered:
  - success;
  - the prompt contents and trusted comments;
  - retry with PR reuse;
  - a person's branch;
  - a push the remote rejects, and PR creation failing;
  - no changes, `.github/` changes, and a rename out of `.github/` (this test
    failed before the fix and passes after it);
  - agent self-commits;
  - checks failing twice, and fixed on the second try;
  - agent non-zero exit, timeout, missing summary, huge or secret summary, and a question;
  - setup failure, and a missing secret;
  - duplicate dispatch, duplicate after finishing, closed or not-ready issues;
  - the issue changing while waiting;
  - no worker;
  - manual-run spelling and actors, and an unlisted repo.

  On success it asserts that the GitHub token appears in no Box command and
  nowhere on the Box's disk. After every outcome it asserts that the agent
  secret is nowhere on the Box's disk.
- **`test/claim.test.mjs`.** 25 rounds of four claimers racing for one worker
  (never two owners); liveness; two workers; a stale list; a resume failure;
  the label limit; the release order.
- **`test/recover.test.mjs`.** Recovery: idempotence, ownership, a Box that
  changed hands. Reaper: completed, live, local and unreadable runs, and its
  own run.
- **`test/github.test.mjs`.** Error classes, retries and their limit, a write
  never repeated, the token override, PR reuse, the run mark.
- **`test/git-host.test.mjs`.** Clone, apply, commit and push; an empty patch;
  a patch that reaches outside the repo is refused; no token in the clone's
  config.

Not run: the smoke tests, `plan.mjs` against a real issue, the dry run through
GitHub, and any end-to-end run. All need credentials this environment does not
have. `check-setup.mjs` was run without them and correctly reported the four
missing secrets and the unconfigured `gh` sign-in.

## The first end-to-end run

The README section "Safe first run" lists the steps and every point to check.
It needs, from the owner:

1. The token: Contents, Issues and Pull requests read/write on all three repos,
   and `rashid-hq-os` in its selection.
2. `gh auth login` (repo, workflow).
3. `gh variable set FACTORY_DRY_RUN --body true`.
4. `set-secrets.mjs --yes`.
5. `check-setup.mjs --probe-writes` printing `All good.`
6. The dry run through GitHub, then one real run with `agent:opencode`.
