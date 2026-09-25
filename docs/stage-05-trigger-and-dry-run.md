# Stage 5 — trigger, secrets, dry run

Half done. The half that needs **write access to repo settings** is blocked on
the owner's own `gh` sign-in, not on anything in the factory.

## What ran

```
node scripts/install-trigger.mjs          # preview
node scripts/install-trigger.mjs --yes    # with GH_TOKEN = FACTORY_GITHUB_TOKEN
```

**MOT1209/KingAgent — done.**

```
labels ready: ready, factory:running, factory:review, factory:needs-attention,
              agent:claude, agent:opencode
pull request: https://github.com/MOT1209/KingAgent/pull/3
```

PR #3 adds `.github/workflows/factory-ready.yml` (+34) against `main`, titled
"Send ready issues to the software factory". Verified: the branch's file
decodes to the template with `__FACTORY_REPO__` → `MOT1209/kingagent-factory`,
the `ready` label, and `contains(fromJSON('["MOT1209"]'), github.actor)`. The
owner merges it.

**MOT1209/rashid-hq-os — stopped.**

```
gh label create ready --repo MOT1209/rashid-hq-os ... --force
HTTP 403: Resource not accessible by personal access token
```

Reproduced by hand, so it is not a fluke. The same command against KingAgent
succeeded in the same run, and reads on rashid-hq-os work (`GET
/repos/.../labels` returns 200). Not archived, not disabled, `has_issues`
true, public — nothing on the repo side explains it. So the token's write
reach differs per repository, which means the owner has to look at its
repository selection.

No labels and no PR were created on rashid-hq-os. The script stops at the
first failure, so nothing after that line ran there either.

## What did not run, and why

`set-secrets.mjs --yes` was **not** run. Its prerequisite was probed instead:

```
GET /repos/MOT1209/kingagent-factory/actions/secrets   → 403 Resource not accessible
GET /repos/MOT1209/kingagent-factory/actions/variables → 403 Resource not accessible
```

Both 403 **before** anything was written, so the owner's fine-grained token
simply does not carry the Secrets and Variables permissions it would need.
Setting `FACTORY_DRY_RUN` needs the same Variables permission, so that is
blocked too.

## Safe, and why

Nothing can start a real run right now, which is why proceeding without
dry-run mode was acceptable:

1. Neither app repo has the trigger on its default branch yet (checked on
   GitHub, not locally: `KingAgent` has `ci.yml, release.yml, ship.yml`;
   `rashid-hq-os` has `ci.yml`).
2. Neither app repo has the `FACTORY_GITHUB_TOKEN` secret, which the trigger
   needs to call the factory.
3. There were no leftovers to confuse this: 0 open `factory/install-trigger`
   PRs and no factory labels on either repo before this stage ran.

Dry-run still has to be switched on before the first test issue, and before
anyone merges a trigger PR, once the owner is signed in.

## Still to do, in order

```bash
gh auth login --hostname github.com --git-protocol https --scopes repo,workflow
gh variable set FACTORY_DRY_RUN --body true --repo MOT1209/kingagent-factory
node --env-file=.env scripts/set-secrets.mjs --yes
node scripts/install-trigger.mjs --yes        # finishes rashid-hq-os
# owner merges PR #3 and the new rashid-hq-os PR
```

The owner's `gh auth login` also removes the one remaining FIX in
`check-setup.mjs`. It cannot be run from here: it is an interactive sign-in,
and the skill keeps every sign-in with the owner.
