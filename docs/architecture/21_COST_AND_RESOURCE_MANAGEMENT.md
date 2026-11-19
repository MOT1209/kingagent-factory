# 21 — Cost and Resource Management

Status: **mostly missing**. Only time is measured and bounded.

## 1. What exists (verified)
| Control | Evidence |
|---|---|
| Wall-clock limits: agent (`agentTimeoutMinutes` 30), each command (`commandTimeoutMinutes` 25), wait for worker (`waitForWorkerMinutes` 20), run budget (default 155, `runBudgetMinutes`), job 175 min | `factory.config.json`, `config.mjs:172-184`, `factory.yml` |
| Parallelism bound: one run per issue (`concurrency` group), worker pool = 2 workers, `boxLimit` 10 | `factory.yml`, `config.mjs:146` |
| Change-size limits per PR (100 files / 5000 lines) | `guards.mjs:56` |
| Usage record: `agentMinutes`, attempts, worker, agent, outcome per run (JSON artifact, 90 days) | `report.mjs runRecord`, `factory.yml` "Keep the run record" |
| Provider quota awareness: only reactive (usage-limit text → failover) | `guards.mjs:49` |

**Not measured:** tokens, money, Actions minutes consumed, Box compute/storage, per-repo totals over time, retry cost. The Claude path is a subscription (`CLAUDE_CODE_OAUTH_TOKEN`), so its marginal cost is *quota*, not dollars, and the CLI reports no token counts to the factory. No budget (money or quota) is enforced; risk R-23.

## 2. Cost model
| Resource | Unit | Source of truth |
|---|---|---|
| Agent time | minutes | runner timer (exists) |
| Provider quota | requests/limit hits; tokens & USD **only where the provider reports them** | adapter (06) |
| Actions minutes | minutes × OS multiplier | GitHub Actions API for the run (`getWorkflowRun`, `github.mjs:186`) |
| Box time/storage | minutes of running, count of Boxes | Upstash API (`Box.list`); plan terms **to be verified** |
| Storage | artifacts, store size | retention policy |
| Retries | attempts × (minutes + quota) | run record |
All values are stored per task and rolled up; unknown values are `null`, never estimated silently.

## 3. Budgets (five levels, hierarchical)
`global ⊇ factory ⊇ project ⊇ task ⊇ agent`. A budget = `{minutes, usd?, tokens?, attempts, concurrent}` with a period (per task, day, month). A child budget is carved from the parent; the sum of children never exceeds the parent's remaining value (checked in the same transaction as slot acquisition, 14 §3).

Enforcement points:
1. **Admission** — before claiming a sandbox: concurrency cap, remaining minutes, remaining attempts. (Config-only version = Phase 02 task T02-7, **not yet delivered**: no cap keys exist in `config.mjs` today.)
2. **During** — supervisor compares usage to the task budget at each heartbeat (`runScript` `onTick`); at 80% warn, at 100% stop (process-group kill) and hand back.
3. **Escalation** — a stronger model is allowed only if the budget remaining covers it (15 §4).
4. **After** — usage written to the record; period totals updated; exhaustion blocks admission with a clear reason on the issue.

## 4. Preventing runaway cost
Max 4 active sub-agents per parent (14) *and* a factory/global concurrency cap; attempts per task and escalations per task capped; queue instead of start when over cap; same-issue duplicate events collapse (exists: concurrency group + `factory:running` stand-down, `pipeline.mjs:113`); circuit breaker per provider (15); per-repo daily minute cap; Windows verifier minutes capped separately (higher multiplier).

## 5. Optimisation levers (measured before applied)
Route simple tasks to economical tiers (15); skip the agent when a deterministic fix suffices; reuse images/snapshots; per-task fresh Box only where measured value (TD-07) justifies start-up cost; trim prompt context via the K-limit (20).

## 6. Reporting
`scripts/report.mjs` already aggregates outcomes and minutes from logs (`aggregateStats`, `report.mjs:86`); Phase 03 adds the store-backed rollups and cost-per-accepted-PR once usage fields exist. No dashboard (UI deferred); CLI + job summary + issue comments.

## 7. Acceptance
Phase 02-follow-up/03: caps present in config and tested (admission refuses over-cap runs). Phase 05: usage fields captured per provider where reported; budget exhaustion holds a task before start and stops one in flight (fixture). Phase 13: cost review with real numbers; no unmeasured resource silently reported as zero.
