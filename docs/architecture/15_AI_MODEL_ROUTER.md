# 15 — AI Model Router and Main-Agent Model Authority

Status: **proposal**. Provider abstraction, registries, usage and health are in 06; this document adds complexity classification, the authority rule and escalation. Today there is **no routing**: the agent type is chosen by `agent:<name>` label or priority/busy-share (`workers.mjs:37-53`), and the model is whatever the CLI defaults to (`factory.config.json agents.claude.boxSettings: []`, a recorded owner choice; opencode's only settings are `autoupdate:false, share:"disabled"`).

## 1. Authority rule (formal)
> **M-1.** Only the Main Agent, or a human with the `factory-admin` role acting as an explicit override, may set or change `assigned_model` and `assigned_provider` of a task.
> **M-2.** Sub-agents cannot choose, change, request-and-apply, or override a model or provider, nor change routing policy.
> **M-3.** The assignment is fixed **before** execution starts. The agent launch command is **rendered by the orchestrator** from the assignment; an agent cannot influence its own model by editing files, environment or prompts it controls.
> **M-4.** Every assignment or change is an append-only event: `{task, agent, from, to, reason, tier, decided_by, budget_remaining, at}`.

Enforcement point: the orchestrator's task-write path rejects `assigned_model` writes that lack a Main-Agent or admin capability (same token mechanism as 14 §3). The Main Agent may assign the same model to all agents or different ones per task.

**Reality check that shapes the design (verified in code):** the model is currently baked into the Box by `applyBoxSettings` (`box.mjs:86-114`) at provisioning time, not per job. Per-task assignment therefore needs a *per-job* mechanism: a CLI flag or per-job settings file written by `runAgent` (`agents.mjs:148`). Whether the installed Claude Code and OpenCode CLIs accept a model flag/setting at the pinned versions is **not verified here** — the first Phase 05 task is a capability probe (§6).

## 2. Complexity classification (deterministic first)
A pure function `classify(task, repoFacts) → {tier, score, reasons[]}`; the Main Agent may *request* a different tier with a reason, the policy validates it against budget and permissions. Inputs and weights are configuration, versioned, and unit-tested:

| Signal | Source | Example effect |
|---|---|---|
| Scope / affected files | planner estimate, later actual diff (`stagedChanges`, `git-host.mjs:97`) | >10 files → +2 |
| Architectural impact | touches module boundaries, config, schema, public API | +3 |
| Technical uncertainty | issue lacks acceptance criteria; `NEEDS_CLARIFICATION` history | +2 |
| Dependencies | number of upstream tasks | +1 each (cap 3) |
| Security implications | paths such as auth, secrets, CI, crypto; Security role | +4 and floor tier = Powerful |
| Required reasoning | planner tag (refactor, design, debug-unknown) | +2 |
| Testing complexity | e2e/browser/integration needed | +2 |
| Expected cost | from history of similar tasks (21) | informational, enforces cap |

Score → tier: Simple (≤2) → **Economical**; Medium (3–5) → **Balanced**; Difficult (6–9) → **Powerful**; Highly complex (≥10) or architecture redesign → **Advanced**. Rename a file or create a small file lands Economical; a moderate bug Balanced; a complex feature Powerful; an architecture redesign or hard architectural problem Advanced (prompt §7.1 examples).

The classifier is deterministic so it is testable and cannot be prompt-injected through the issue text; an LLM may add *advisory* signals (e.g. "uncertainty high") that are capped in weight and recorded.

## 3. Registries (configuration, never hard-coded model ids)
```json
{ "providers": { "claude-code": {"adapter":"cli","auth":"CLAUDE_CODE_OAUTH_TOKEN"},
                 "opencode":    {"adapter":"cli","auth":"OPENCODE_AUTH_JSON"} },
  "tiers": { "economical": ["opencode:<model>"], "balanced": ["claude-code:<model>"],
             "powerful": ["claude-code:<model>"], "advanced": ["claude-code:<model>"] } }
```
Each concrete model entry carries `verified_at`, `capabilities`, `context`, `cost_basis` (`subscription-quota | per-token`), and `status`. **A model is assignable only if its `status` is verified by a probe** (§6): no assumption that any named model exists.

## 4. Fallback, escalation, rate limits
- **Fallback** (provider failure): next entry in the tier, then another provider. Exists in embryo: one retry on a different agent type when `isTransientAgentFailure` matches (`pipeline.mjs:238-247`, `guards.mjs:49`). Replace the regex with typed provider errors from adapters (06 §4).
- **Escalation** (the agent struggles): triggers recorded in the supervisor — a repo check failed twice (today one fix round, `pipeline.mjs:267-274`), >70% of the time budget used with no diff, repeated identical errors, a `NEEDS_SPLIT`. The Main Agent may **stop** the instance (slot released, 14), reassess, and assign the next tier **only if** the task budget and the parent budget allow; otherwise the task is handed to a human. Maximum one escalation per tier step, maximum two per task.
- **Rate limits / health**: circuit breaker per provider (open after N consecutive typed failures; half-open probe), exposed to the classifier as "unavailable".
- **Manual override**: `factory-admin` sets a model with a mandatory reason; budget checks still apply; recorded as `decided_by: user:<id>`.

## 5. Cost and token tracking
Per task: minutes (exists, `report.mjs`), attempts, escalation count, provider, model. Tokens and money only where the provider reports them; the subscription-based Claude CLI path reports **neither today** (01 finding on cost), so budgets for it are in minutes and attempts (21). Per-token providers enter later via adapters.

## 6. Verification before assignment (first Phase 05 task)
Extend `scripts/smoke-test.mjs` (which already creates a Box and asks the agent for "BOX OK") into a **capability probe** per provider/model: CLI version, accepted model flag, a trivial task round-trip, summary-file behaviour, reported usage fields, failure-class samples. Output: registry entries with `verified_at`. Re-probed on a schedule and after image rebuilds.

**Result (2026-11-21, R-36 resolved).** `node --env-file=.env scripts/probe-models.mjs <claude|opencode> --model <id> ... --yes` creates one Box like the smoke test, asks each model for `PROBE OK`, and marks a model `verified` only when the CLI's own report names the requested model as the one that answered:
- Claude Code 2.1.293: `--model`; `--output-format json` reports `modelUsage`. `haiku` → `claude-haiku-5-5`, `sonnet` → `claude-sonnet-5-5`, `opus` → `claude-opus-5-5`.
- OpenCode 1.18.29: `-m provider/model`; `run --format json` omits the model, so the probe reads `opencode export <session>` and trusts only the assistant messages' `providerID/modelID` (the user message carries the request). `opencode/big-pickle`, `opencode/deepseek-v4.1-flash-free`.

The entries live in `factory.config.json` under `factory.orchestration.registry` (with `verified_at`, `cli_version`). `factory.orchestration.enabled: true` turns on **shadow** routing only: a `model.assign` event with `shadow: true`; the run still uses the worker's agent and its default model. The pure rules are in `src/core/probe.mjs`.

**Applying the model (off by default).** `factory.orchestration.apply: true` makes the run use the tier's first verified model *of the claimed worker's agent type*; the orchestrator renders it into the command with the agent's `modelFlag` (`--model` for Claude Code; `-m` at `{model}` for OpenCode, after `run`), quoted and checked against the model-id pattern (M-3). It is recorded as `model.assign` with `shadow: false`. With no such model, or no `modelFlag`, the CLI default is used. The circuit breaker is still not persisted across runs.

## 7. Model performance evaluation
Replays on the frozen task suite (08 §5) and live metrics: first-try check-pass rate, minutes per accepted change, human-edit rate, escalation rate, per tier/model. Router weights change only through the improvement pipeline with human approval (08) — never automatically.

## 8. Acceptance (Phase 05)
Unit tests for `classify` on a labelled fixture set; a sub-agent token cannot write `assigned_model` (403); every assignment/change has an event; escalation respects budget; a failed-provider fixture falls back; an unverified model is refused; override requires role and reason; a real run records the assignment and the model actually used.
