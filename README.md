# KingAgent Software Factory

Put a `ready` label on a GitHub issue in an app repo. A coding agent picks it up inside an Upstash Box, makes the change, runs the repo's checks and opens a pull request. You review it and merge it yourself. The factory never merges.

Repos, workers and agent types are listed in [factory.config.json](factory.config.json). The stage reports in [docs/](docs/) record what was set up and tested so far. **Status:** the whole pipeline is covered by automated tests against a local stand-in for the Box and GitHub, but no real issue has gone through it yet (see [Known limitations](#known-limitations)).

## How a run works

```
app repo                    factory repo (this one), on the Actions runner                 Upstash Box (one worker)
────────                    ──────────────────────────────────────────────                 ────────────────────────
issue gets "ready" ──► factory-ready.yml ──repository_dispatch──► factory.yml
(by an allowedActor)                                               ├ reap-stale.mjs   free workers of runs that are finished
                                                                   ├ plan.mjs         dry run, read-only
                                                                   └ run.mjs
                                                                      claim a worker ─────────────────────────► labels on the Box
                                                                      clone the repo (holds the token)
                                                                      check the branch is the factory's
                                                                      send the repo as a tarball ─────────────► unpack, branch, setup
                                                                                                                sign the agent in, run it
                                                                                                                checks (one retry for the agent)
                                                                      take the change back as a patch ◄──────── git diff
                                                                      apply it, check the paths, commit
                                                                      push with a lease, open or update the PR
                                                                      release the worker ─────────────────────► secrets and work folder deleted, Box paused
                                                                   recover-run.mjs   only if run.mjs failed, timed out or was cancelled
```

**The GitHub token never enters the Box.** The Box user has passwordless sudo and the Box keeps its disk between jobs, so anything an agent leaves behind could see whatever later passes through the Box. All git work that needs the token runs on the Actions runner: the clone, the branch check, the commit and the push. The Box receives the code as a tarball and returns the change as a patch. What gets pushed is decided on the runner, from that patch.

## Issue states

| Label | State | Set by | What to do |
| --- | --- | --- | --- |
| `ready` | Eligible, or waiting for a worker | You | Nothing. Adding it starts a run. While a run waits for a free worker the issue keeps `ready`. |
| `factory:running` | A run owns the issue | Factory | Wait. Other runs for the same issue stand down. |
| `factory:review` | Pull request open | Factory | Review and merge it yourself. The PR says `Closes #<n>`, so merging closes the issue. |
| `factory:needs-attention` | Failed, timed out, cancelled, or the agent asked a question | Factory | Read the factory's comment, fix the cause, add `ready` again. |
| `agent:<name>` | Optional | You | Forces an agent type (`agent:claude`, `agent:opencode`). |

Each outcome sets exactly one of the first four labels and removes the other three. The factory never adds `ready` itself, so it never retries on its own: every retry is a person adding `ready` again. Inside one run, a failing check gives the agent exactly one second attempt.

| From | Event | To | Comment says |
| --- | --- | --- | --- |
| `ready` | worker claimed, issue still ready | `running` | which worker, with the run's mark |
| `ready` | no worker within `waitForWorkerMinutes` | `ready` (unchanged) | no free worker; re-add `ready` |
| `ready` | missing agent secret, unknown `agent:` label | `needs-attention` | which secret or label |
| `running` | PR opened or updated | `review` | the PR link |
| `running` | setup, agent, checks, push or PR failed; no changes; `.github/` touched; branch has a person's commit; agent asked a question | `needs-attention` | the reason, with masked output |
| `running` | run cancelled, timed out or lost | `needs-attention` | stopped before it finished (from recovery) |
| any | issue closed, or `ready` missing | unchanged | nothing; the run skips |
| `running` | a second event for the same issue | unchanged | nothing; the second run stands down |

## Prerequisites

- Node 20.6 or newer (the workflow uses 24), git, tar, and the [GitHub CLI](https://cli.github.com/) signed in as the owner (`gh auth login --scopes repo,workflow`). The `gh` sign-in is only for the setup scripts that write repo settings.
- An Upstash account with Box access and an API key (`UPSTASH_BOX_API_KEY`).
- A fine-grained GitHub token (`FACTORY_GITHUB_TOKEN`) whose repository selection includes **this repo and every app repo** in the config, with these repository permissions:

  | Permission | Why |
  | --- | --- |
  | Contents: read and write | cloning and pushing `factory/issue-<n>`, and the trigger's `repository_dispatch` call to this repo |
  | Issues: read and write | labels and comments |
  | Pull requests: read and write | opening and updating the pull request |
  | Metadata: read | added automatically |

  It does **not** need Secrets, Variables, Workflows or Administration. The owner's own `gh` sign-in sets those. Reading this repo's Actions runs (for the stale-worker sweep) uses the workflow's own `GITHUB_TOKEN`, which `factory.yml` grants `actions: read`.
- One sign-in per agent type:

  | Agent | Secret | Where it comes from |
  | --- | --- | --- |
  | `claude` (Claude Code, subscription) | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token`, run by you in a terminal |
  | `opencode` (OpenCode Zen) | `OPENCODE_AUTH_JSON` | the whole file `opencode auth login` writes, as one line |

## Installation and configuration

```bash
npm ci
cp .env.example .env          # fill it in yourself; never paste values into chat or issues
node --env-file=.env scripts/check-setup.mjs
node --env-file=.env scripts/check-setup.mjs --probe-writes   # also tests the token's write permissions
```

`check-setup.mjs` prints no secret values, only their lengths, and tells the failure classes apart: no answer from GitHub (network), a token GitHub does not accept (401), a missing permission (403), a repo the token cannot see (404). It checks:

- the tools, and the config;
- which secrets have a value;
- the token's identity, and that every repo is reachable and spelled the way GitHub spells it;
- whether each app repo has the trigger on its default branch;
- the Box key and the Box budget;
- whether the workflow's timeouts cover the worst case.

With `--probe-writes` it also sends write requests that GitHub must refuse as invalid: an empty label name, an empty pull request, a malformed ref. Nothing is created. GitHub checks permissions before it validates a request, so a 422 answer means the permission is there and a 403 means it is missing. The probe of this repo is a real `repository_dispatch` for an event nothing listens to. The script ends with `All good.` or a numbered list of things to fix.

`factory.config.json` is validated every time it is loaded. A config with problems is refused with every problem listed:

- placeholders left from the template;
- missing sections or labels, and labels that clash (the busy label must not start with `run-`);
- unknown agent types, and duplicate workers or repos;
- workers whose `enabled` is not true or false, an empty repo list, and no enabled worker at all;
- unsafe branch prefixes, and timeouts that are not positive numbers.

Then, once, as the owner:

```bash
gh auth login --hostname github.com --git-protocol https --scopes repo,workflow
gh variable set FACTORY_DRY_RUN --body true --repo MOT1209/kingagent-factory   # dry run first
node --env-file=.env scripts/set-secrets.mjs            # preview: names and lengths only
node --env-file=.env scripts/set-secrets.mjs --yes      # values go through stdin, never printed
node scripts/install-trigger.mjs                        # preview
node scripts/install-trigger.mjs --yes                  # labels + a PR adding the trigger to each app repo
```

`set-secrets` puts the Box key, the token and the agent sign-ins on this repo, and only `FACTORY_GITHUB_TOKEN` on each app repo, which the trigger needs to call the factory. Merge each trigger pull request yourself. Both scripts can be run again safely: secrets are overwritten, labels are created with `--force`, and an open trigger PR is reused.

**Repository allowlist.** The factory only works on repos listed under `repos` in the config. `run.mjs` refuses anything else, and only those repos get a trigger. Each repo names its `baseBranch`, its `setup` commands (run in the Box before the agent) and its `checks` (they must pass before a PR is opened).

## Workers and agent types

```bash
node --env-file=.env scripts/provision-workers.mjs          # preview
node --env-file=.env scripts/provision-workers.mjs --yes    # one paused Box per enabled worker
node --env-file=.env scripts/smoke-test.mjs opencode        # preview
node --env-file=.env scripts/smoke-test.mjs opencode --yes  # one Box, asks the agent for "BOX OK", deletes the Box
```

The smoke test uses a little of the agent's quota.

- **Add a worker:** add an entry under `workers`, then run `provision-workers.mjs --yes`.
- **Add an agent type:**
  1. Describe it under `agents`: sign-in secrets under `auth`, and a `command` that contains `{prompt}` and `{summary}`.
  2. Install its CLI in [worker/setup.sh](worker/setup.sh).
  3. Add a line `<SECRET>: ${{ secrets.<SECRET> }}` for each of its secrets to the "Show the plan" and "Do the work" steps of `.github/workflows/factory.yml`. The workflow passes secrets by name, not as one blob, and `test/workflow.test.mjs` fails until the lines are there.
  4. Rebuild the image with `scripts/build-snapshot.mjs`.
  5. Smoke-test it.

Both agent types share one worker image (`factory.snapshotId`).

### Worker lifecycle

A worker is one named Box (`kaf-claude-01`, `kaf-opencode-01`). Box labels say who holds it:

| Labels on the Box | Meaning |
| --- | --- |
| neither `busy` nor a `run-` label | free |
| `run-<run id>` alone | a run is in the middle of claiming it |
| `run-<run id>` and `busy` | that run holds it |
| `busy` alone | a maintenance script (`build-snapshot`, `apply-box-settings`) holds it, or one died |

Box labels have no compare-and-set, so a claim is built from two operations that are each atomic: adding a label, and listing labels.

1. Skip any Box that already has `busy` or a `run-` label.
2. Add this run's `run-<id>` label.
3. List the labels again. If another `run-` label is there, take ours back and retry after a random pause. Otherwise the Box is ours; only now is `busy` added.

Two runs can never both get past step 3: whichever listed first had already added its label, so the other one's list shows it. In the worst case both back off and retry. This assumes Upstash answers a label list with every label added before it. If waking the Box fails after the claim, the claim is taken back, so a broken Box is never left marked busy.

Release removes `busy`, pauses the Box, then removes the run label, in that order, so a run can never remove a newer owner's `busy`. Before release, every job deletes the agent's sign-in files and the whole work folder: the app's code, the prompt, the logs and the summary.

### Recovery

- **After a killed run.** If the work step fails, hits its own 165-minute limit, or is cancelled, the workflow's last step runs `recover-run.mjs`. It only acts on a Box that still carries that run's label. It deletes the sign-in files, frees the worker, and moves the issue to `factory:needs-attention`. The issue is only touched if the factory's latest "picked this up" comment names that run, so a newer run's issue is never changed.
- **Before every run.** `reap-stale.mjs` looks up each claimed worker's run on GitHub. It recovers the claim only when GitHub says that run is `completed`. A claim whose run is still queued or running is never touched, and neither is one whose run cannot be looked up, such as a run started from a laptop (`run-local…`).
- **By hand.** `release-worker.mjs <worker>` asks GitHub whether the holding run is still going. It refuses if the run is, or if it cannot tell, unless you pass `--force`.

All three can be run again safely; a second run does nothing.

## Safe first run

Do these in order, using one harmless test issue in one app repo. Each step only goes ahead when the one before it worked.

1. `node --env-file=.env scripts/check-setup.mjs --probe-writes` prints `All good.`
2. `node --env-file=.env scripts/status.mjs` shows the workers free.
3. **Dry run, locally.** Create a test issue in an app repo, for example "Add the line `factory test` to the end of README.md". Add `ready` and `agent:opencode` to it (OpenCode passed its smoke test; Claude has not). Then run
   `node --env-file=.env src/plan.mjs MOT1209/KingAgent <issue>`.
   It reads the issue and the workers, prints which worker would take it, and warns about a missing sign-in. It changes nothing.
4. **Dry run, through GitHub.** With `FACTORY_DRY_RUN=true` on this repo, remove and re-add `ready` on the test issue. The app repo's trigger should start a `Factory` run here that stops after "Show the plan". This proves the trigger, the token and the secrets without running an agent.
5. **The real run.** This spends agent quota. Delete the `FACTORY_DRY_RUN` variable (or set it to `false`), then remove and re-add `ready`. Watch the run in the Actions tab.
6. **Check every point.**
   - One `Factory` run started, and its log says `Worker opencode-01 (opencode) claimed`.
   - The issue went `ready` → `factory:running` → `factory:review`, with a "picked this up" and a "Pull request ready for review" comment.
   - One pull request from `factory/issue-<n>` into the repo's base branch. It says `Closes #<n>`, shows the agent's summary, and names the checks that passed. Its diff is the intended change only.
   - The run's log shows the checks running, and "Released worker opencode-01".
   - `scripts/status.mjs` shows every worker free.
   - The Box holds no sign-in files: `node --env-file=.env scripts/box-exec.mjs opencode-01 "ls -la ~/.local/share/opencode /workspace/home/.factory" --pause` should report both missing.
   - Removing and re-adding `ready` updates the same PR rather than opening a second one.
7. Set `FACTORY_DRY_RUN` back to `true` until you want the factory live. Merge or close the test PR yourself.

You can also start a run by hand from the Actions tab ("Run workflow"). Only users in `factory.allowedActors` are accepted. Type the repo and issue number exactly as GitHub shows them (`MOT1209/KingAgent`, `7`), so the run queues behind any other run for the same issue.

## Everyday commands

```bash
node --env-file=.env scripts/status.mjs                          # who is free, busy, and which run holds each worker
node --env-file=.env src/plan.mjs <owner/repo> <issue>           # dry run for one issue
node --env-file=.env scripts/release-worker.mjs <worker> [--force]   # free a worker whose run is dead
node --env-file=.env scripts/recover-run.mjs <run id> [owner/repo issue]   # what the workflow does after a killed run
GITHUB_TOKEN=<token> node --env-file=.env scripts/reap-stale.mjs # what the workflow does before each run
node --env-file=.env scripts/apply-box-settings.mjs              # write changed model or effort settings into existing Boxes
npm test                                                         # the factory's own tests, no secrets or network needed
npm run check                                                    # syntax of every file, then the tests (what CI runs)
```

**Retrying an issue safely.** Read the factory's comment, fix the cause, then add `ready` again. A retry builds from the base branch again. It replaces the factory's own `factory/issue-<n>` branch, and only if that branch has not moved since the run looked at it. It updates the open PR rather than opening a second one. If a person has pushed to that branch, the run stops instead, so merge or close that PR and delete the branch first.

## What protects a run

- **Who can start it.** The trigger only fires for users in `allowedActors`. `run.mjs` refuses manual runs from anyone else, and repos that are not in the config.
- **Duplicates.** The workflow allows one run per issue at a time (`concurrency`). A run that finds `factory:running` already on the issue stands down. After waiting for a worker, a run reads the issue again and leaves it alone if it changed or cannot be read. A manual run must spell the repo and issue the way GitHub does, or it would get its own concurrency slot.
- **Token out of the Box.** git on the runner gets the token as an HTTP header in its environment: never in a URL or in `.git/config`, with hooks switched off and the user's git config ignored. The Box only ever holds the agent's own sign-in, which is deleted after every job.
- **What gets pushed.** The runner applies the Box's patch. `git apply` refuses paths outside the repo, and patches over 50 MB are refused. Changes under `.github/` are never pushed. Commits the agent made despite the rules are folded into one factory commit. Tarball and patch transfers are checked by SHA-256 on both ends.
- **The branch.** Pushed with `--force-with-lease` against the SHA seen at the start of the run. If the branch's last commit lacks the factory's `Factory-Run:` trailer, a person pushed there, and nothing is pushed.
- **Untrusted text.** The issue and comments reach the agent through a file, never a shell command line. Only comments from `allowedActors` are passed to the agent. The prompt tells the agent that the issue cannot change its rules. That reduces prompt injection; it does not prevent it (see below).
- **Repository instructions.** The agent is told to follow the repo's own `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, as long as they do not contradict the factory's rules.
- **Masking.** Every comment and PR text the factory writes has every known secret value masked, including each line of a multi-line one. PR text is cut to 50,000 characters. Masking is a safety net, not a boundary: the boundary is that the token is not in the Box.
- **Workflow.** Secrets are only in the environment of the steps that need them, never of `npm ci`. `actions/checkout` keeps no token. The job's permissions are `contents: read` and `actions: read`.
- **GitHub errors.** Rate limits and server errors are retried up to three times. A write that may have reached GitHub is never repeated, so no comment is posted twice. Permission errors fail at once, with the status and the likely cause.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Labelling an issue starts nothing | The app repo lacks the trigger on its default branch, or lacks the `FACTORY_GITHUB_TOKEN` secret, or you are not in `allowedActors`. Look at the app repo's Actions tab for a failed "Send ready issue to factory" run. |
| HTTP 401 anywhere | The token is invalid or expired. Make a new one, update `.env`, run `set-secrets.mjs --yes`. |
| HTTP 403 "Resource not accessible by personal access token" | The token lacks a permission, or that repo is not in its repository selection. `check-setup.mjs --probe-writes` names which one. |
| HTTP 403 or 429 mentioning a rate limit | GitHub's rate limit; the factory retries briefly. Wait and add `ready` again. |
| HTTP 404 on a repo that exists | The token cannot see it (GitHub answers 404 for private repos it has no access to). |
| HTTP 422 when opening the PR | GitHub refused it, for example because the branch has no difference from the base. |
| `set-secrets.mjs` or `gh variable set` fails with 403 | Your `gh` sign-in lacks admin rights on that repo. These scripts use your own sign-in, not the fine-grained token. |
| "No free worker in time" | Every worker stayed busy. Run `status.mjs`. A worker whose run is finished is freed by the next run's sweep, or by `release-worker.mjs`. |
| Issue stuck on `factory:running` | The run was killed and its recovery step could not run (a lost runner). Run `recover-run.mjs <run id> <repo> <issue>`. |
| Status shows `busy` with no `run-` label | A maintenance script holds the worker, or one died. Once you are sure none is running: `release-worker.mjs <worker>`. |
| `needs-attention`: "needs the secret(s) …" | The factory repo lacks that agent's sign-in. Run `set-secrets.mjs --yes`. |
| `needs-attention`: agent stopped with exit code 1 | The comment shows the agent's output. "You've hit your weekly limit" is the Claude subscription's quota; wait for the reset or use `agent:opencode`. |
| `needs-attention`: "did not finish within" | The agent or a command ran past its timeout and was stopped. Make the issue smaller, or raise the timeouts in the config (then re-run `check-setup.mjs`). |
| `needs-attention`: branch "was not made by the factory" | Someone pushed to `factory/issue-<n>`. Merge or close that PR and delete the branch, then add `ready` again. |
| `needs-attention`: a check failed | The change failed a repo check twice. The comment shows the output. Reword the issue or fix it by hand. |
| `needs-attention`: "changed files the factory never pushes" | The agent touched `.github/`. Make that change by hand. |
| `needs-attention`: "checksum mismatch" | A transfer to or from the Box was damaged. Add `ready` again; if it repeats, the Box files API is at fault. |

## Security notes

- Never commit `.env`; it is in `.gitignore`. Never put secret values in issues, comments or chat.
- The agent runs with full permissions inside its Box (`--dangerously-skip-permissions` for Claude, passwordless sudo for everyone). The Box is the sandbox. While it works it can read its own sign-in, the repo's `secrets` (if a repo defines any), the code and the internet. It cannot reach the GitHub token.
- **Prompt injection is not solved.** Anyone who can open an issue writes its body, and the body is the agent's task. Only add `ready` to issues whose text you have read. A manipulated agent can still write bad code, or leak what is in its Box; the pull request review is the control for the first.
- The agent can change tests and check scripts along with the code. Passing checks are not proof the change is right. Review every pull request.
- The factory does not change branch protection or repository settings, and it never merges. A push that branch protection refuses fails the run.

## Known limitations

- **No end-to-end run has happened.** The Factory workflow has never run on GitHub. Blockers that need the owner are in [docs/stage-08-production-readiness.md](docs/stage-08-production-readiness.md).
- **Claude has not completed a run.** Its smoke test hit the subscription's weekly limit ([docs/stage-04-smoke-tests.md](docs/stage-04-smoke-tests.md)). OpenCode passed its smoke test.
- **Tested only locally:** the Box file transfers (`files.write` and `files.read` in base64, with offsets), the git header authentication against github.com, and the `--probe-writes` interpretation. They follow the SDK's types and GitHub's documented behaviour, but have not run against the real services. The checksums make a broken transfer fail loudly rather than silently.
- **The claim's safety rests on Upstash** answering label lists consistently, as above. That is assumed, not verified.
- **Only GitHub Actions runs can be recovered automatically.** A run started from a laptop holds its worker until `release-worker.mjs --force`.
- **Concurrent box creation.** If two runs create the same missing worker Box at once, two Boxes with one name can exist. Create workers ahead of time with `provision-workers.mjs`.
- **A lost runner.** If the runner is lost entirely, no step runs, including recovery. Once GitHub marks that run finished, the next factory run's sweep frees the worker and hands the issue back. Until another run starts, nothing does; run `recover-run.mjs` by hand if you need it sooner.
