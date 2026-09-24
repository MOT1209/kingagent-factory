# Stage 2 — the factory repo, scaffolded

What exists now, and what still has to happen. Written for someone following
along later: every command here was actually run unless it says "not run".

## Where it lives

`_local/kingagent-factory/` inside the KingAgent checkout. That folder is in
KingAgent's `.gitignore` on purpose (`_local/`), so the factory never becomes
part of KingAgent's history and KingAgent's repo-shape gate does not see it.

The factory is its own repository. It gets its own remote in Stage 3; until
then it is a local `git init` with one commit.

## The decisions this config encodes

| Key | Value | Why |
| --- | --- | --- |
| `factory.repo` | `MOT1209/kingagent-factory` | Same owner as both app repos, because one fine-grained token covers one owner. |
| `boxNamePrefix` / `boxLabel` | `kaf-` / `kingagent-fac` | The factory only ever lists Boxes carrying its label, so it cannot claim someone else's. |
| `gitAuthor` | Rashid, `208480351+MOT1209@users.noreply.github.com` | A real person's name and a real noreply address: preview hosts and branch protection reject commits from a generic bot identity. |
| `allowedActors` | `MOT1209` | A run spends the owner's Claude subscription. Only they may start one until they add a name. |
| `boxLimit` | 10 | The free Upstash plan's concurrent-Box limit. `check-setup.mjs` does the arithmetic against whatever else is on the account. |
| `browser` | `true` | Upstash runs the Chromium. Free in the plan, and fixed at Box creation. |
| `agentTimeoutMinutes` | 30 | KingAgent is a large codebase: reading it is most of the work. |
| `commandTimeoutMinutes` | 25 | `npm ci` for an Electron repo plus the full suite plus lint. |
| `boxSettings` | `[]` for claude and pi | The owner chose each CLI's own default model and effort. The empty list is the record of that choice, not an oversight. |

## The repos, and why their commands are what they are

**MOT1209/KingAgent** — `baseBranch: main`

```
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm test
npm run lint
node scripts/check-syntax.mjs
```

- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is not a speed trick, it is the difference
  between a working setup and a failing one. 79 test files import from
  `src/main/`, and every one of them fakes `electron` through a `Module._load`
  hook, so **no test needs the Electron binary**. Downloading ~100 MB of it in
  every Box is pure cost and one more way for `npm ci` to fail.
- The checks are exactly the repo's own CI gate: syntax, tests, lint. The
  coverage floor is deliberately left out — it is a Linux-only CI step, and
  re-running the whole suite under instrumentation doubles the CPU time of
  every job against a 5-CPU-hour monthly budget.
- `npm run fetch-model` (which downloads Whisper weights) is **not** run. It
  only exists for packaging, and it is the single largest download in the repo.

**MOT1209/rashid-hq-os** — `baseBranch: main`

```
npm ci
npm run test
npm run lint
npm run typecheck
```

`next build` is left out on purpose: it needs the app's environment variables
to succeed, and adding them as repo secrets is a decision the owner has not
made yet. The consequence, stated plainly: **a change that passes these three
checks can still fail to build.** Add `npm run build` and the secrets it needs
when that matters.

## The worker image is mandatory, not optional

`worker/setup.sh` installs Node 24, zsh, OpenCode and Pi. Each line is there
because something needed it:

- **Node 24** — KingAgent declares `engines.node >= 24.0.0`.
- **zsh** — three test files exercise zsh-backed behaviour, which is why the
  repo's CI installs zsh on Ubuntu before running the suite. Without it in the
  image, every KingAgent job fails its checks and the agent gets sent in circles.
- **OpenCode and Pi** — neither is in the stock Box.

## Not verified yet, on purpose

- **OpenCode's credentials.** The `auth` block copies a local
  `opencode auth login` file into the Box. If OpenCode Zen turns out to need no
  credential at all, that block is dead weight carrying a secret, and the smoke
  test will say so. Delete it rather than leave it.
- **Where `~` is for OpenCode and Pi.** Claude and Codex are documented as
  living under `/workspace/home`; the OpenCode and Pi paths here are a guess
  from each project's own docs (`/home/boxuser/...`, `/workspace/home/...`).
  The smoke test is the judge, and the fix is one line in this config.
- **Pi's sign-in.** It is BYOK, so the secret is the whole `auth.json` after
  `/login` on a real machine. The user does that step; we never see the value.
- **Freebuff is not a worker.** It has no API key and no account by design
  ("no keys to paste", ad-supported sessions), so there is nothing for the
  factory's `auth` contract to place in a Box. The reverse-engineered
  `freebuff2api` proxies that exist are not an option: they circumvent a
  service's access controls. The sanctioned path for "agents on my GitHub
  issues" is Freebuff Cloud, a separate product and a separate integration.

## Commands run in this stage

```bash
cp -r <skill>/assets/template _local/kingagent-factory   # 30 files, dotfiles included
# factory.config.json and worker/setup.sh written by hand
npm install                                            # exit 0, package-lock.json created
node -e "import('./src/config.mjs').then(m => console.log(m.loadConfig().factory.repo))"
# → MOT1209/kingagent-factory  (the loader rejects OWNER and "ask", so this is a real check)
git init && git add -A && git commit
```

## Next: Stage 3, and it needs the owner

Four secrets, all entered by the owner into `.env` and never pasted into chat:

1. `UPSTASH_BOX_API_KEY` — Upstash console, Box section.
2. `FACTORY_GITHUB_TOKEN` — fine-grained, owner `MOT1209`, access to the factory
   repo and both app repos, with Contents / Pull requests / Issues read+write.
3. `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token`, in a real terminal.
4. `OPENCODE_AUTH_JSON` and `PI_AUTH_JSON` — the two sign-in files.

Then `node --env-file=.env scripts/check-setup.mjs`, which reads no secret
values and reports which are missing.
