# 22 — Observability, Analytics and Documentation Automation

Status: **partial**. Per-run observability exists; there is no store, no cross-run analytics except log parsing, and no metrics for agents/models/cost.

## 1. What exists (verified)
- **Job summary** for every run: outcome, worker, agent minutes, PR, reason (`report.mjs summaryMarkdown`, called in `run.mjs`).
- **`factory-stats` log line** and a versioned **run record JSON** artifact `factory-run-<run id>`, no secret values, 90-day retention (`report.mjs runRecord/writeRunRecord`; `factory.yml` "Keep the run record"; added in Phase 02).
- **Operator views**: `scripts/status.mjs` (workers, claim state against GitHub), `scripts/doctor.mjs` (setup + workers, exit 1 on problems), `scripts/report.mjs` (totals from `gh run view --log`), `src/ops.mjs` (`describeWorkers`, `advice`).
- **Health checks**: `scripts/check-setup.mjs` (tools, secrets presence, token, repos, trigger presence, Box key/budget, timeout coverage).
- **Audit trail**: GitHub issue comments with run marks (`github.mjs runMark`), PR history.

Gaps: no durable store (F-D3); no per-step timings; no agent/model dimension beyond the agent type; no provider health or error-rate series; no cost; no alerting; logs are not queryable.

## 2. Event model (append-only; the single write path for observability)
`{id, ts, factory_id, project_id, task_id, run_id, actor{type: main|sub|human|system, id}, type, data, schema_version}`. Types: `task.state`, `slot.acquire|release`, `model.assign|change`, `step.result`, `failure.state` (17), `guard.hit`, `provider.error`, `budget.warn|stop`, `approval.request|grant`, `policy.denial`, `security.event`. No secret values (redaction before write, `makeRedactor`). Security-relevant events (policy denial, sub-agent token misuse) are also surfaced to the owner.

## 3. Indicators (each with a definition and a source)
| KPI | Definition | Source |
|---|---|---|
| PR rate | runs with outcome `review` / runs not skipped | run records |
| First-try check pass | tasks whose first `checks` result was green | `step.result` |
| Repair success | repairs reaching `RepairVerified` / repairs started | `failure.state` |
| Human-edit rate | commits by a person on factory branch before merge | git history |
| Minutes per accepted change | agent+check minutes for merged PRs | usage |
| Escalation rate / model performance | escalations per task; pass rate by tier/model | `model.change` |
| Provider error rate, health | typed errors per provider per window | `provider.error` |
| Delegation efficiency | useful parallel time / total; queued-for-slot time; slot utilisation (≤4) | `slot.*` |
| Resource use | worker utilisation, queue wait, Box count | `Box.list`, claims |
| Cost | per task/project/factory (21) | usage |
| Incidents | stuck claims, cleanups failing, policy denials | events |
| Audit completeness | share of runs with a full event chain | events |

Rule: **correctness and verified quality outrank speed** — dashboards/reports list quality KPIs first; speed KPIs never trigger actions that skip verification.

## 4. Where it is shown (no new UI)
CLI reports (`scripts/report.mjs`, extended), GitHub job summaries, issue/PR comments, scheduled markdown report PR (read by humans). Any future UI reads the same API (09, deferred).

## 5. Alerting
Start with GitHub-native: a failing `reap`/`doctor` run, a `security.event`, budget stop, provider circuit open → issue comment + failed workflow (existing notification path). External paging only if the owner asks.

## 6. Documentation automation (prompt §14)
Principle: **docs are generated from, or checked against, verified implementation**.
- **Generated/checked artefacts**: config reference from `config.mjs` validation rules; agent/role docs from manifests; skills/MCP docs from registry; API docs from the OpenAPI spec (Phase 03+); change history/release notes from merged PR titles and run records; testing reports from verification records (18).
- **Doc tests** (extend the pattern of `test/workflow.test.mjs`, which already fails when documented secrets are missing from the workflow): CI fails if an architecture document marks a subsystem "implemented" without a resolvable `file:line` or run id; if README names a script that does not exist; if a documented config key is unknown to `loadConfig`.
- **Status vocabulary** used across `docs/architecture`: implemented (code + test or real run), partial, missing, planned. A `planned` item may never appear in a feature list as available.
- **Stale-claim rule**: this audit found the README claiming "no end-to-end run has happened" after six real runs (01 Rev. 2, fixed by PR #17). A scheduled job compares README "Known limitations" with the latest run records and opens an issue on contradiction.
- Documentation role (04) drafts; a human reviews; the factory never merges docs either.

## 7. Acceptance (Phase 03 for events/run store; Phase 13 for full coverage)
Every run yields a validated event chain; KPIs recomputable from raw events; doc tests in CI; a seeded stale claim is detected; redaction test proves no secret value reaches events.
