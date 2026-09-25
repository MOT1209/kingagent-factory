# Stage 4 — one smoke test per agent type

One passed, one did not, and the failure is not the factory's.

## opencode — PASS

```
node --env-file=.env scripts/smoke-test.mjs opencode --yes
```

```
Box to create: kaf-smoke-opencode, from this agent type's worker image
Browser access: on
Created Box innocent-redbird-91096
Agent CLI found: /opt/runner/bin/opencode  1.18.29
Exit code 0 after 0.2 min
Summary file: BOX OK
Deleted Box innocent-redbird-91096.
PASS: the agent answered from inside a Box.
```

The log shows the agent doing real work: it read `.job/prompt.md` and wrote
`.job/summary.md`, which is exactly the contract `run.mjs` depends on. This
also settles the open question from Stage 2 — the sign-in block for OpenCode
was accepted and nothing complained about a missing credential. What it does
**not** settle is whether that credential was needed at all; Zen may well work
without it. The 51-character file is harmless either way, and the smoke test
is not the place to find out.

The Box was created from the worker image, because the image existed by then.
That is the documented order for an agent whose CLI is not in the stock Box.

## claude — FAIL, account limit, not the factory

```
node --env-file=.env scripts/smoke-test.mjs claude --yes
```

```
Box to create: kaf-smoke-claude, from the stock Upstash image
Browser access: on
Created Box united-leopard-38569
Agent CLI found: /opt/runner/bin/claude  2.1.280
Exit code 1 after 0.2 min
Summary file: You've hit your weekly limit · resets 2am (UTC)
Deleted Box united-leopard-38569.
FAIL
```

Everything the smoke test is meant to prove about the Box itself was proven
before the agent was even asked: the Box key works, the CLI is present, the
sign-in file was placed, browser access is on. The agent then answered with
the subscription's own weekly-limit message instead of `BOX OK`.

This ran before the worker image existed, so it started from the stock image.
It will be re-run **after** 2am UTC, at which point it will start from the
image like the opencode one did — a second, better test for the price of one.

## Worker Boxes

```
node --env-file=.env scripts/provision-workers.mjs claude-01 --yes
```

| Worker | Box | id | Created from |
| --- | --- | --- | --- |
| claude-01 | kaf-claude-01 | nice-wahoo-20812 | the shared image |
| opencode-01 | kaf-opencode-01 | obliging-pipefish-88362 | a plain Box; the image was then built inside it |

Both paused, both with browser access, both labelled `kingagent-fac` and
`agent-<type>`.

`status.mjs` afterwards: `2 free, 0 busy, 0 disabled`.

## What has not been verified

- The claude agent type has never completed a run. It is blocked on the
  weekly limit, not on anything here.
- Neither agent type has run against a real repo yet. That is Stage 7.
