# Stage 3 — accounts and secrets

The owner put all four values into `.env` themselves. Only names and lengths
were ever read; no value was printed.

| Variable | State | Used by |
| --- | --- | --- |
| `UPSTASH_BOX_API_KEY` | set (68 chars) | every Box script |
| `FACTORY_GITHUB_TOKEN` | set (93 chars) | the factory workflow, and the trigger in each app repo |
| `CLAUDE_CODE_OAUTH_TOKEN` | set (108 chars) | the claude agent type |
| `OPENCODE_AUTH_JSON` | set (51 chars) | the opencode agent type, copied to `/home/boxuser/.local/share/opencode/auth.json` |

`PI_AUTH_JSON` is an empty leftover line from the pi agent type that was
dropped in commit b48dd04. It is not in `.env.example` and nothing reads it.

## check-setup, run for real

```
node --env-file=.env scripts/check-setup.mjs
```

```
ok    Node 24.19.0 / git / gh installed
FIX   gh is not signed in. Run: gh auth login
ok    config: 2 repos, 2 enabled workers, agent types claude + opencode
ok    4 secrets are set (lengths only)
ok    token reaches MOT1209/kingagent-factory, MOT1209/KingAgent, MOT1209/rashid-hq-os
ok    Box key works, 0 Boxes on the account, budget 10 - 0 - 2 = 8 spare
ok    worst case 155 min, inside the workflow's 170
```

`Reachable is not proof of write access. The first dispatch and the first
push are the real test` — that stays open until Stage 5.

## Still open in this stage

**`gh auth login` has to be run by the owner in a real terminal**, with the
`workflow` scope:

```
gh auth login --hostname github.com --git-protocol https --scopes repo,workflow
```

Three scripts need it and nothing else does: `set-secrets.mjs --yes`,
`install-trigger.mjs --yes` (labels, clone, PR) and `create-demo-issues.mjs`.
`check-setup.mjs` reports it as the one remaining FIX.
