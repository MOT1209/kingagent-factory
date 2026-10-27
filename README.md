# KingAgent Software Factory

Put a `ready` label on a GitHub issue in an app repo. A coding agent picks it up inside an Upstash Box, makes the change, runs the repo's checks and opens a pull request. You review it and merge it yourself. The factory never merges.

Repos, workers and agent types are listed in [factory.config.json](factory.config.json). The stage reports in [docs/](docs/) record what was set up and tested so far.

## How a run works

```
app repo                      factory repo (this one)                    Upstash Box (one worker)
─────────                     ───────────────────────                    ────────────────────────
issue gets "ready"  ──►  factory-ready.yml  ──repository_dispatch──►  factory.yml
(by an allowedActor)                                                   ├ plan.mjs      dry run, read-only
                                                                       ├ run.mjs       claim a worker ──► clone, branch, setup
                                                                       │                                 sign the agent in, run it
                                                                       │                                 checks (one retry for the agent)
                                                                       │                                 commit, push, open PR
                                                                       │               release worker ◄─ secrets deleted, Box paused
                                                                       └ recover-run.mjs only if run.mjs failed, timed out or was cancelled
```

Issue labels, one at a time:

| Label | Meaning |
| --- | --- |
| `ready` | You want the factory to work on it. Adding it starts a run. |
| `factory:running` | A run owns the issue. Other runs for the same issue stand down. |
| `factory:review` | A pull request is open. Review it. |
| `factory:needs-attention` | The factory stopped. The comment on the issue says why. Fix it and add `ready` again. |
| `agent:<name>` | Optional. Forces an agent type (`agent:claude`, `agent:opencode`). |

A worker is one named Box (`kaf-claude-01`, `kaf-opencode-01`). It is busy while its Box carries the `busy` label, plus a `run-<id>` label naming the run that holds it.

## Prerequisites

- Node 20.6 or newer (the workflow uses 24), git, and the [GitHub CLI](https://cli.github.com/) signed in as the owner (`gh auth login --scopes repo,workflow`). The `gh` sign-in is only for the setup scripts that write repo settings.
- An Upstash account with Box access and an API key.
- A fine-grained GitHub token (`FACTORY_GITHUB_TOKEN`) whose repository selection includes **this repo and every app repo** in the config, with these repository permissions:

  | Permission | Why |
  | --- | --- |
  | Contents: read and write | pushing the `factory/issue-<n>` branch, and the trigger's `repository_dispatch` call to this repo |
  | Issues: read and write | labels and comments |
  | Pull requests: read and write | opening and updating the pull request |
  | Metadata: read | added automatically |

  It does **not** need Secrets, Variables, Actions, Workflows or Administration. Those are set by the owner's own `gh` sign-in.
- One sign-in per agent type: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and `OPENCODE_AUTH_JSON`, the file `opencode auth login` writes.

## Installation and configuration

```bash
npm ci
cp .env.example .env          # fill it in yourself; never paste values into chat or issues
node --env-file=.env scripts/check-setup.mjs
```

`check-setup.mjs` changes nothing and prints no secret values, only their lengths. It checks the tools, validates the config, checks which secrets have a value, whether the token reaches every repo, whether each app repo has the trigger on its default branch, the Box key and Box budget, and whether the workflow timeouts cover the worst case. It ends with `All good.` or the list of things to fix.

`factory.config.json` is validated every time it is loaded. A config with problems is refused with every problem listed: placeholders left from the template, unknown agent types, duplicate workers or repos, unsafe branch prefixes, label clashes (the busy label must not start with `run-`), and timeouts that are not positive numbers.

Then, once, as the owner:

```bash
gh auth login --hostname github.com --git-protocol https --scopes repo,workflow
gh variable set FACTORY_DRY_RUN --body true --repo MOT1209/kingagent-factory   # dry run first
node --env-file=.env scripts/set-secrets.mjs            # preview: names and lengths only
node --env-file=.env scripts/set-secrets.mjs --yes      # values go through stdin, never printed
node scripts/install-trigger.mjs                        # preview
node scripts/install-trigger.mjs --yes                  # labels + a PR adding the trigger to each app repo
```

`set-secrets` puts the Box key, the token and the agent sign-ins on this repo, and only `FACTORY_GITHUB_TOKEN` on each app repo (the trigger needs it to call the factory). Merge each trigger pull request yourself.

## Workers and agent types

```bash
node --env-file=.env scripts/provision-workers.mjs          # preview
node --env-file=.env scripts/provision-workers.mjs --yes    # one paused Box per enabled worker
node --env-file=.env scripts/smoke-test.mjs claude          # preview
node --env-file=.env scripts/smoke-test.mjs claude --yes    # one Box, asks the agent for "BOX OK", deletes the Box
```

The smoke test uses a little of the agent's quota. To add a worker, add an entry under `workers` and run `provision-workers.mjs --yes`. To add an agent type, describe it under `agents` (sign-in secrets under `auth`, a `command` with `{prompt}` and `{summary}`), install its CLI in [worker/setup.sh](worker/setup.sh), rebuild the image with `scripts/build-snapshot.mjs`, and smoke-test it. The worker image is shared by both agent types (`factory.snapshotId`).

## Safe first run

Do these in order. Each step only goes ahead when the one before it worked.

1. `node --env-file=.env scripts/check-setup.mjs` prints `All good.`
2. **Dry run, locally.** Create a test issue in an app repo, add `ready`, then run
   `node --env-file=.env src/plan.mjs MOT1209/KingAgent <issue>`.
   It reads the issue and the workers, prints which worker would take it and warns about a missing sign-in. It changes nothing.
3. **Dry run, through GitHub.** With `FACTORY_DRY_RUN=true` on this repo, remove and re-add `ready` on the test issue. The app repo's trigger should start a `Factory` run here that stops after "Show the plan". This proves the trigger, the token and the secrets without running an agent.
4. **One real run.** Pick a tiny, self-contained issue (for example "add one line to the README") with an `agent:` label for the agent whose quota you want to spend. Delete the `FACTORY_DRY_RUN` variable (or set it to `false`), then remove and re-add `ready`. Watch the run in the Actions tab.
5. Check the result: one pull request from `factory/issue-<n>`, described by the agent, saying which checks passed; the issue labelled `factory:review`; `node --env-file=.env scripts/status.mjs` shows every worker free again.
6. Set `FACTORY_DRY_RUN` back to `true` until you want the factory live.

You can also start a run by hand from the Actions tab ("Run workflow"). Only users in `factory.allowedActors` are accepted.

## Everyday commands

```bash
node --env-file=.env scripts/status.mjs                   # who is free and who is busy
node --env-file=.env scripts/release-worker.mjs <worker>  # free a worker a killed run left busy
node --env-file=.env scripts/recover-run.mjs <run id> [owner/repo issue]   # what the workflow does after a killed run
node --env-file=.env scripts/apply-box-settings.mjs       # write changed model or effort settings into existing Boxes
npm test                                                  # the factory's own unit tests, no secrets needed
```

## What protects a run

- **Who can start it.** The trigger only fires for users in `allowedActors`, and `run.mjs` refuses manual runs from anyone else.
- **Duplicates.** One workflow run per issue at a time (`concurrency`). A run that finds `factory:running` already on the issue stands down. After waiting for a worker, a run reads the issue again and leaves it alone if `ready` is gone or another run took it.
- **Claiming a worker.** A run skips a Box that already carries `busy` or another run's label, then adds its own `run-<id>` label and `busy`. If two runs still land on one Box at the same moment, the lower run id keeps it and the other tries again. The tests race two claimers against one worker and check that exactly one wins.
- **Interrupted runs.** If the work step fails, hits its own 165-minute limit, or is cancelled, the workflow's last step runs `recover-run.mjs`. It deletes the sign-in files from the Box that still carries that run's label, frees the worker, and moves the issue from `factory:running` to `factory:needs-attention`. After a normal failure, which cleans up for itself, it does nothing.
- **Label states.** Every outcome is one transition that sets one factory label and removes the other three, so an issue never shows two states.
- **The branch.** The factory pushes `factory/issue-<n>` with `--force-with-lease` against the SHA it saw when the run started. If the branch already exists and its last commit lacks the factory's `Factory-Run:` trailer, a person has pushed there, and the factory stops instead of overwriting their work.
- **Secrets.** The GitHub token is in the clone URL only for the clone, the branch check and the push; it is removed from the remote right after cloning, and git's credential store is switched off. The agent's sign-in lives in its own file that setup and checks do not read. Sign-in files are deleted from the Box after every job, because a paused Box keeps its disk. Every comment and pull request text the factory writes has every known secret value masked. In the workflow, secrets are only in the environment of the steps that need them, not of `npm ci`.
- **Untrusted text.** The issue and comments reach the agent through a file, never a shell command line. Only comments from `allowedActors` are passed to the agent, because anyone can comment on a public repo. The prompt tells the agent the issue cannot change its rules.
- **Repository instructions.** The agent is told to follow the repo's own `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, as long as they do not contradict the factory's rules.
- **What gets pushed.** Commits the agent made despite the rules are folded into one change. Changes under `.github/` are never pushed; the issue gets `factory:needs-attention` instead.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Labelling an issue starts nothing | The app repo lacks the trigger on its default branch, or lacks the `FACTORY_GITHUB_TOKEN` secret, or you are not in `allowedActors`. Look at the app repo's Actions tab for a failed "Send ready issue to factory" run. |
| The trigger run fails with HTTP 403 or 404 | The token lacks Contents write on this repo, or this repo is not in its repository selection. |
| `set-secrets.mjs` or `gh variable set` fails with 403 | Your `gh` sign-in lacks admin rights on that repo. These scripts use your own sign-in, not the fine-grained token. |
| `gh label create` fails with 403 on one repo | That repo is not in the token's repository selection, or the token lacks Issues write there. |
| Factory run says "No free worker in time" | Every worker stayed busy. `scripts/status.mjs`; free a stuck one with `release-worker.mjs` after checking no run is using it. |
| Issue stuck on `factory:running` | The run was killed and recovery could not run. Run `recover-run.mjs <run id> <repo> <issue>`, or remove the label by hand and run `release-worker.mjs`. |
| `needs-attention`: "needs the secret(s) …" | The factory repo lacks that agent's sign-in. Run `set-secrets.mjs --yes`. |
| `needs-attention`: agent stopped with exit code 1 | The comment shows the agent's output. "You've hit your weekly limit" is the Claude subscription's quota; wait for it to reset or use `agent:opencode`. |
| `needs-attention`: branch "was not made by the factory" | Someone pushed to `factory/issue-<n>`. Merge or close that PR and delete the branch, then add `ready` again. |
| `needs-attention`: a check failed | The agent's change failed a repo check twice. The comment shows the output. Reword the issue or fix it by hand. |

## Security notes

- Never commit `.env`; it is in `.gitignore`. Never put secret values in issues, comments or chat.
- The agent runs with full permissions inside its Box (`--dangerously-skip-permissions` for Claude). The Box is the sandbox. It holds the agent's own sign-in while it works, but not the GitHub token.
- Anyone who can open an issue can write its body. Read an issue before you add `ready` to it, because the body is the agent's task.
- Review every pull request. The agent can change tests and checks along with the code; passing checks are not proof the change is right.
- The factory does not change branch protection, repository settings or anything outside the issue, its branch and its pull request.

## Known limitations

- The Claude agent type has not completed a run yet: its smoke test hit the subscription's weekly limit (see [docs/stage-04-smoke-tests.md](docs/stage-04-smoke-tests.md)). OpenCode passed its smoke test.
- No end-to-end run has happened yet. As of this change the factory repo has no workflow runs at all.
- A stale `busy` label is only cleared by `recover-run.mjs` (automatic after a killed run) or `release-worker.mjs`. The factory cannot tell a stale label from a live one by itself, because the token has no Actions permission.
- If two runs ever create the same missing worker Box at the same moment, two Boxes with one name can exist. Create workers ahead of time with `provision-workers.mjs` to avoid it.
- If a runner is lost entirely, no step runs, including recovery. Use `recover-run.mjs` by hand.
