# 00 — Executive Report (Revision 2, 2026-11-19)

Scope: audit, architecture, roadmap. **No feature was implemented, nothing was deployed, published, merged or deleted, no dependency or workflow was changed.** The only changes are Markdown files under `docs/architecture/` on the local branch `docs/master-audit` (uncommitted). Details and evidence are in the numbered documents; section references below point to them.

## 1. Current repository status
`MOT1209/kingagent-factory` @ `main` `6cb7693`: ~5,600 lines of Node 24 ESM, one runtime dependency (`@upstash/box ^0.8.0`), no server, database or UI. Phase 01 docs (PR #16) and Phase 02 fixes (PRs #17–#19) are already merged. CI (`Test`, run `44604013267`): **181/181 pass, 0 skipped** on Linux. Local Windows: 181 tests, 129 pass, **52 skipped by design** (need `setsid`), 0 fail. (01 §7.1)

## 2. Existing working capabilities (code + test or real run)
Issue-label → dispatch → worker claim → agent in a Box → repo checks → patch applied on the runner → push with lease → PR; never merges. Six real end-to-end runs with Claude Code and OpenCode produced PRs on three app repos (01 §2). Also: config validation, secret masking, protected paths, change-size guards, one provider failover, one fix round, recovery and stale-worker sweep, run records, operator scripts (01 §3–4).

## 3. Partially implemented
Observability (per-run records, no store); label-order race (mitigated by an 8 s settle wait, late labels still missed); Box browser (enabled and started, **no automation tool installed, no recorded use**); extensibility (config-driven agents/repos, no roles/skills/MCP); workspace isolation (scrub-and-verify, residual `setsid` escape); security hygiene (Actions pinned, `claude.yml` gated, `claude-code-review.yml` not).

## 4. Missing
Main Agent, delegation and the four-sub-agent limit; model selection/routing (CLI default only); PowerShell and any Windows execution; Playwright; resource limits and egress policy; durable store; task contracts; project/requirements/roadmap engine; error classification/diagnosis; verification records; memory; skills/MCP management; multi-factory; budgets and cost data (minutes only); self-improvement. (01 §3, §7.3)

## 5. Critical technical problems
1. `runIssue` is one ~240-line function — blocks roles and DAGs (F-D2).
2. No durable state — blocks budgets, memory, UI, improvement (F-D3).
3. The statistical claim-race test failed once (7/10) — CI trust (N6, R-39).
4. Parallelism is bounded by a static pool of **2 workers** (N8) — the four-agent limit is a ceiling, not a throughput guarantee.
5. Only the last 80 log lines are kept — diagnosis is blind (N5).

## 6. Security findings (07, 01 §5.1, §7)
Agent runs with `--dangerously-skip-permissions` inside the Box (the Box is the boundary; prompt injection "not solved"); one fine-grained PAT writes to every app repo; residual cross-job process leakage; a token was exposed in chat during setup and **rotation is not evidenced**; `zod` high advisory (transitive); `claude-code-review.yml` ungated with `id-token: write`; no resource or network limits. Controls added to the design: slot ledger and capability tokens (14), Main-Agent-only model assignment (15), credential-free executors and egress gate (16), anti-fabrication evidence (17–18), approvals and audit (07 §7).

## 7. Architecture recommendations
Modular monolith Core, one store, deterministic policy engine that validates an LLM-assisted Main Agent (13, TD-16); keep the working pipeline and wrap it (strangler); tasks coordinated only through contracts; GitHub stays the intake and review gate; config-as-code in git (02, 11).

## 8. Multi-agent strategy (04, 14)
Main Agent proposes, orchestrator enforces. **At most 4 active sub-agents per parent task, enforced by an atomic slot acquisition with leases and capability tokens**, not by prompts; sub-agents cannot spawn, delegate, change policy, models or providers; DAG, path locks and budget carving prevent duplicate, cyclic or over-budget work. Delivered in Phase 04 after the store (03).

## 9. Model router strategy (15, 06)
Deterministic complexity classifier → tier (economical, balanced, powerful, advanced) → concrete model from a **probe-verified registry**. Only the Main Agent (or an authorised admin override) assigns models, before execution, as recorded events; the orchestrator renders the agent command. Fallback, bounded escalation within budget, circuit breakers. First task: verify the CLIs accept a per-task model at all (R-36).

## 10. Execution environment strategy (16)
Terminal: keep and harden (full logs, caps). PowerShell: `pwsh` 7 in the Linux image (to be verified) plus an **ephemeral GitHub-hosted Windows verifier** (patch in, evidence out, no credentials). Browser: Playwright over CDP to the Box's Chromium (spike first); browser tests of untrusted content only if egress can be enforced. Fresh Box per task evaluated (TD-07).

## 11. Multi-factory strategy (03)
Current config becomes `factories/default`; per-factory pools, secrets namespace, memory, budgets; Builder lifecycle; default-deny isolation with negative tests; credentials per factory (GitHub App). Phase 07, after the Core, agents and execution tiers exist.

## 12. Development roadmap (10)
13 phases in the owner's order, dependency-aware, no dates: 01 audit (done) · 02 stabilisation (mostly done; **02b** carry-over open) · 03 Core · 04 multi-agent · 05 router · 06 real execution · 07 multi-factory · 08 skills/MCP · 09 project management · 10 error detection and QA · 11 memory · 12 self-improvement · 13 security and production readiness. **Web and Desktop apps are deferred** (TD-15). Each phase lists objectives, tasks, dependencies, affected and new modules, acceptance, tests, security, rollback and completion conditions.

## 13. Phase 02 preparation
Phase 02 was **already executed** by the owner's earlier work (01 §7.2); the prompt's "prepare Phase 02" is therefore replaced by **02b**: T02b-1 caps (R-23), T02b-2 gate `claude-code-review.yml` + `zod` PR (TD-21), T02b-3 deterministic claim-race test, T02b-4 token rotation (owner, GitHub UI), T02b-5 `npm audit` in CI. After 02b, Phase 03 starts with the store decision.

## 14. Outstanding technical decisions (owner)
1. Store hosting for Phase 03 (TD-03) and whether the Core is a service or runs inside Actions at first (13 §6).
2. GitHub App vs per-factory PAT (TD-04).
3. Worker pool size or fresh-Box-per-task to make parallel sub-agents real (TD-07, N8).
4. Approve **TD-15** (defer Web/Desktop) as recorded, and the phase re-sequencing.
5. Whether to run opt-in canary issues that spend agent quota (18 §6).
6. Approval to apply the `zod` fix and the workflow gate (they change files outside `docs/`).

## What could not be verified
Upstash label-list consistency under real concurrency; Box egress control; per-task model flags in the pinned CLIs; PowerShell 7 and Playwright on the Debian 12 ARM64 image and Playwright-over-CDP; real cost per run (no data); exposure of `claude-review`; Actions Windows-minute rate; `src/admin.mjs` beyond its tests; whether the token was rotated. **Also:** documents 03, 05, 06, 07, 08 and 09 come from Phase 01; I verified their structure and updated phase references and the parts touched by the new rules, but did **not** re-verify every claim inside them. No new real end-to-end run was started (it would spend agent quota).

## Completion gate (owner prompt §26)
| Requirement | Evidence | Done |
|---|---|---|
| Repository inspected; implementation verified | 01 §7, tests and CI results above | yes |
| Existing vs missing distinguished | 01 §3, §7.3; this report §2–4 | yes |
| Architecture docs created/updated | README index | yes |
| Multi-agent, four-agent limit, central model assignment | 04 §10, 14, 15 | yes (design) |
| Real terminal, PowerShell, browser; security and isolation | 16, 07 §7 | yes (design; PowerShell/browser unimplemented and partly unverified) |
| Multi-factory; skills/MCP; self-improvement; cost | 03, 05, 08, 21 | yes (design) |
| Development dependencies; roadmap | 10 | yes |
| Phase 02 prepared | §13 (replaced by 02b because Phase 02 already ran) | yes, with that change |
| Final report | this document | yes |

**Awaiting owner approval. No implementation will start before it.**
