# Stage 6 — the worker image

```
node --env-file=.env scripts/provision-workers.mjs opencode-01 --yes   # one Box to build in
node --env-file=.env scripts/build-snapshot.mjs opencode-01 --shared    # preview
node --env-file=.env scripts/build-snapshot.mjs opencode-01 --shared --yes
```

```
Image:         shared by every agent type, snapshot name kaf-worker-base
Built in:      kaf-opencode-01 (obliging-pipefish-88362)
Setup script:  worker/setup.sh
Baked in:      tools only. A shared image holds no model settings
Browser:       on
...
--- check
v25.9.0   git 2.39.5   zsh 5.9   Claude Code 2.1.280   codex-cli 0.156.1   opencode 1.18.29
node major 25 ok
Removed sign-in files and old workspaces.
Secret scan clean.
Snapshot kaf-worker-base: ab599155-38c6-41c2-a904-d393bcba198e
Saved as factory.snapshotId.
Box released and paused.
```

## Why one shared image

Both agent types need the same things: Node 24 and zsh for KingAgent's
checks, and the OpenCode CLI which no stock Box has. The only per-agent
content is `boxSettings`, and `createAgentBox` writes that into every new Box
anyway (`src/box.mjs:178`), so a tools-only shared image loses nothing and
saves one full rebuild. `factory.snapshotId` is the result; no agent type has
its own `snapshotId`.

## The Node versions, stated exactly

`worker/setup.sh` installs nodesource's Node **24.21.0** at `/usr/bin/node`
and puts `PATH=/usr/bin:$PATH` in `/etc/profile.d/node24.sh`. The stock Box
keeps its own Node **25.9.0** at `/usr/local/bin/node`. Both are still on
disk afterwards.

Which one you get depends on how the shell starts, and the factory is
consistent about it:

| How it runs | node |
| --- | --- |
| `runScript` — every setup, check and agent run (`bash -lc`, `src/box.mjs:42`) | **24.21.0** |
| `sh()` — short housekeeping commands (`mkdir`, `cat`, `grep`) | 25.9.0 |
| `box-exec.mjs` without `bash -lc` | 25.9.0 |

KingAgent asks for `engines.node >= 24.0.0`, so 24 is what it was written
against, and that is what the jobs get.

The build's own `--- check` printed `v25.9.0`, which looks like a
contradiction and is not: the outer login shell of the build sources
`/etc/profile.d` **before** `setup.sh` has created `node24.sh`, so that one
run still had the stock PATH. Every login shell started after the build sees
the file. Verified afterwards:

```
node --env-file=.env scripts/box-exec.mjs claude-01 "bash -lc 'node --version; zsh --version | head -1; claude --version; opencode --version; codex --version; git --version'"
v24.21.0
zsh 5.9 (aarch64-unknown-linux-gnu)
2.1.280 (Claude Code)
1.18.29
codex-cli 0.156.1
git version 2.39.5
```

So the check in `setup.sh` proved the wrong node for the run that built the
image, and would still pass if the nodesource install ever failed. That is
fixed in `worker/setup.sh`: it now exports the new PATH itself on the line
after the `tee`, so the rest of setup and the check see 24. **The snapshot
above predates that fix** — it takes effect on the next image build, and the
fix itself is unverified until then. Nothing else depends on it: later runs
read `profile.d`, and they were verified directly.

## Boxes after the image

- `kaf-opencode-01` was built in, so it already holds everything. The script
  released and paused it.
- `kaf-claude-01` was created afterwards with `provision-workers.mjs` and
  therefore started from the snapshot — the first Box this factory ever made
  with `Box.fromSnapshot`. Browser access came through, which is the thing
  that cannot be added later.

## Not done in this stage

- `codex --version` works but no codex agent type exists. Harmless; the
  stock Box ships it.
- A real action with each tool inside the image: opencode did one (the smoke
  test, `BOX OK`). Claude has not, because of the weekly limit.
- No skills, MCP servers or `jobFiles` are in the image. Nothing asked for
  them yet; they are the cheapest thing to add later, since `jobFiles` do not
  need a rebuild at all.
