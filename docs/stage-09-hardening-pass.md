# Stage 9: hardening pass

Starting point: branch `ccr-b5f3016a-x2svne` at `1a4f9c4` (main after PR #2).
`npm run check` passed 92/92 before any change. The earlier audit's findings
were rechecked against the code; the ones below were still reproducible by
reading the code and are now fixed and covered by tests.

## Fixed

| Area | Defect found | Fix |
|---|---|---|
| GitHub API | A POST that got a 5xx or a dropped connection was retried, so a comment could be posted twice (ambiguous write). | 5xx/network retries only for GET, PUT, PATCH, DELETE and POSTs marked `idempotent` (labels). Rate-limit refusals (429, 403) are retried for every method. |
| GitHub API | No request timeout; fixed 2 s/4 s backoff with no jitter; `Retry-After` dates and `x-ratelimit-reset` ignored. | 30 s timeout, `retryDelayMs` (Retry-After seconds or date, rate-limit reset, exponential, jitter, 60 s cap). |
| GitHub API | Error text was not scrubbed for token shapes. | `scrub()` on every thrown message. |
| Pull requests | An open PR was reused by branch name alone (wrong base or a fork's same-named branch). A create that raced another PR failed. | Reuse only same-repo head and same base; a different base is an error; a 422 re-looks-up and reuses. |
| Protected paths | Only `.github/` (case-sensitive). | Also `CODEOWNERS` (root, `docs/`), any `.git/` path, case-insensitive. |
| Host git | git/tar inherited the whole runner environment (Box key, secrets blob, `GIT_*`). Temp dirs from patch/tar were left behind. Git failures could echo the token. | Allow-list environment (`cleanEnv`), temp dirs removed, token and its base64 form masked in git errors. |
| Issue number | Dispatch payload value went into API paths unchecked. | Must be `^[1-9]\d{0,9}$`, for every event type. |
| Agent sign-in | It stayed on disk while the repo's checks (arbitrary repo commands) ran. | Removed right after the agent ends; signed in again only for the retry. |
| Leftover processes | A process the agent detached into its own session survived. | After each agent run and at cleanup, processes whose cwd is inside the job folder are killed (nothing else is touched). |
| Cleanup | Failures were swallowed and the worker was released anyway. | Cleanup is verified. If anything remains, the run fails, the Box **keeps its claim**, and recovery (which now also removes the work folder and verifies) or `release-worker.mjs` handles it. |
| Summary | `cat` of an unbounded file. | `head -c 200000`. |
| Config | Case-variant duplicate repos, non-username `allowedActors`, unsafe base branches, non-list `setup`/`checks`, more workers than `boxLimit`. | New validation. |
| Operator tools | `plan.mjs` crashed with a stack trace on a missing token; `check-setup.mjs` calls could hang. | Clean message and exit 1; 30 s timeout. |

## Tests

`npm run check` after the changes: **124 tests, 124 passing** (Node 22.22.0,
this container, no network, no credentials). New tests (32) cover each row
above, including: ambiguous POST not repeated, backoff arithmetic, token
scrubbing, PR base/fork/race handling, protected-path variants, environment
allow-list, `GIT_DIR`/`GIT_SSH_COMMAND` not steering the trusted git, a patch
into `.git/hooks`, a hook not running at commit, a push losing to a person's
concurrent push, sign-in absent during checks, sign-in restored for the retry,
a detached process killed, cleanup failure keeping the claim, an unverifiable
cleanup treated as dirty, recovery refusing to release a dirty Box.
Mutation check: disabling the process kill makes its test fail.

These are local tests: real shell, real git, real background processes, local
bare repos, in-memory GitHub and a local Box stand-in. They are not integration
tests against GitHub or Upstash.

## Not done (blocked, nothing was faked)

- **Setup check against real services, GitHub dry run, controlled end-to-end
  run, failure/recovery runs on GitHub.** This session has no
  `FACTORY_GITHUB_TOKEN`, `UPSTASH_BOX_API_KEY` or agent credentials, and no
  `gh` sign-in. `check-setup.mjs` run here correctly reports the five missing
  items. GitHub shows only `Test` workflow runs (7, all successful); the
  `Factory` workflow has never run. No application repository, issue or
  worker was touched.
- Agent adapters were exercised only with scripted stand-in agents. Whether
  Claude (weekly limit hit earlier) and OpenCode work as real agents is
  unverified here.
- Actions are pinned to major tags, not SHAs (see README, Known limitations).
- Processes that change directory before detaching cannot be reached from
  outside the Box (see README).

## Next concrete steps for the owner

1. Create the fine-grained token and Upstash key; `gh auth login`.
2. `gh variable set FACTORY_DRY_RUN --body true`, `set-secrets.mjs --yes`,
   `check-setup.mjs --probe-writes` until it prints `All good.`
3. Dry run through GitHub on a harmless issue; read the workflow log.
4. One real run with `agent:opencode`; inspect the PR; do not merge blindly.

## Verification with real credentials (2026-10-28)

Run from a Windows machine with the real `.env` and a signed-in `gh`. Test
target: `MOT1209/KingAgent` issue #19 ("append `hello` to README.md"), a
harmless issue created for this purpose. No secret value was printed or
committed; the three factory tokens were searched for in the run log and the
PR and not found.

### Executed and passed

| Step | What ran | Result |
| --- | --- | --- |
| 2 | `node --env-file=.env scripts/check-setup.mjs --probe-writes` | exit 0, `All good.` Every write probe allowed on all three repos; Box key works, 8 spare slots. |
| 3 | `gh variable set FACTORY_DRY_RUN --body true`; `scripts/set-secrets.mjs --yes` | exit 0. Four secrets on the factory repo, `FACTORY_GITHUB_TOKEN` on both app repos. |
| 4 | Dry run through GitHub, once by `repository_dispatch` (run 40693579929) and once by `workflow_dispatch` (run 40698393846) | Plan named `MOT1209/KingAgent#19`, worker `opencode-01`, branch `factory/issue-19`, base `main`, then `Dry run only. Nothing was changed.` No branch, PR, comment or label change. |
| 5 (claude) | Real run 40704150016 with `agent:claude` | Worker claimed, agent ran 0.7 min, three checks ran, one changed file (`README.md`), PR #20 against `main` with `+hello` only and one commit, issue `factory:review`, worker released, Box clean (no `.factory`, no work folder, no sign-in file left). |
| 6 | Branch changed by a person (run 40705013040) | Refused: the person's commit `d7ee00c` was still the branch head, issue `factory:needs-attention`, comment says why, worker released. |
| 6 | Duplicate dispatch (runs 40710401467 and 40710419924, seven seconds apart) | One claim and one PR (#22). The second run claimed nothing and skipped. |
| 6 | Cancelled run: force-cancel of run 40728002485 mid-agent, then run 40728148915 | Worker stayed `busy` after the cancel. The next run's `reap-stale` recovered it ("Cleaned and released kaf-claude-01"), set `factory:needs-attention` with a clear comment. Both workers free afterwards. |

### Executed and failed

- **Step 5 with `agent:opencode`** (run 40698638895): failed after 30 minutes,
  `"agent" did not finish within 30 minutes`. The cause is not the factory:
  opencode's own log in the Box says `AI_APICallError: Free usage limit
  reached` (the OpenCode Zen free tier), and opencode then kept retrying
  instead of exiting. The factory handled the timeout correctly (issue
  `factory:needs-attention`, comment, worker released, Box clean).

### Application defects found and fixed

1. `packRepo` wrote the archive to `C:\...\repo.tgz` and GNU tar read `C:` as a
   remote host, so every run from a Windows machine failed at the Box handoff.
   The archive now goes through stdout. Test:
   `packRepo makes a tarball that unpacks to the same files`.
2. `npm run check` used a POSIX `for` loop and failed under cmd.exe. It now runs
   `scripts/check-all.mjs`. Test: `npm run check uses no POSIX shell syntax`.
3. The test double `test/local-box.mjs` built Box paths with backslashes and
   passed `C:/...` archive paths to GNU tar. It now uses forward slashes and
   `--force-local` on Windows only.

### Not executed

- **Agent exits non-zero, agent timeout, a failing check** on GitHub. Each needs
  a change to the factory's own configuration, which this pass was not allowed
  to make. They remain covered only by the unit tests with stand-in agents. The
  opencode run above did exercise the timeout path for real, by accident.
- **opencode end to end**, until its free quota is available again.
- **Idle-agent detection**: opencode sat for 30 minutes after a fatal provider
  error. A faster stop would need the factory to read the agent's own log;
  that was not built.
