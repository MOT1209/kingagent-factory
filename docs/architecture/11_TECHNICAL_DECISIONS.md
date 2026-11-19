# 11 — Technical Decisions

Format per decision: **Decision · Context · Alternatives · Advantages · Disadvantages · Risks · Justification.** Status: `Proposed` unless the owner has decided. Decisions marked **(owner)** appear in the final report's owner-decision list.
Comparison baseline = the current stack: Node 24 ESM, one dependency (`@upstash/box`), GitHub Actions + issues, Upstash Boxes, no database (01).

## TD-01 Keep GitHub Issues + Actions as the first intake and execution trigger
- **Context**: verified working end-to-end on 6 real runs; reviews happen in GitHub PRs.
- **Alternatives**: own queue/worker service now; webhook receiver service.
- **Advantages**: zero new infra; free audit trail; review gate already exists.
- **Disadvantages**: ≤ 175-minute jobs, Actions minutes cost, coarse concurrency (`factory.yml` group per issue), latency of dispatch.
- **Risks**: Actions outage = factory outage. **Justification**: no measured bottleneck; revisit when Core can pull tasks (Phase 03+) — the contract makes the trigger swappable.

## TD-02 Stay on Node.js (ESM), add TypeScript types only at module boundaries
- **Context**: all code is ESM JS; KingAgent/rashid-hq-os use TS/Node; one contributor.
- **Alternatives**: rewrite in TypeScript; switch to Python/Go for the Core.
- **Advantages**: no rewrite; 167 tests keep working; shared language with the owner's apps and Electron.
- **Disadvantages**: weaker static guarantees (mitigate with JSDoc types + schema validation of contracts).
- **Risks**: contract drift. **Justification**: "don't introduce unnecessary technologies" — nothing in the audit needs a new language.

## TD-03 Postgres as the system of record **(owner: provider/budget)**
- **Context**: need transactional, queryable state for tasks, runs, approvals, budgets, audit, memory; read by Web, Desktop, orchestrator.
- **Alternatives**: SQLite/libSQL; Upstash Redis (already a vendor); files in git; no store.
- **Advantages**: relational integrity, row-level security for factory isolation, mature tooling, PITR backups, SQL analytics for improvement metrics.
- **Disadvantages**: new operational dependency and monthly cost; migrations discipline needed.
- **Risks**: vendor choice lock-in (mitigate: standard Postgres, no proprietary features). **Justification**: SQLite cannot be shared by Actions runners and a dashboard safely; Redis is weak for relational queries and audit; git is not a query/transaction store. The managed-Postgres connectors already available to the owner make this low effort.

## TD-04 Replace the shared PAT with GitHub App installations (per factory) **(owner)**
- **Context**: one PAT writes to all repos and sits in every repo's secrets (S2); this setup needed manual token repository-selection edits.
- **Alternatives**: keep PAT; one PAT per factory; deploy keys per repo.
- **Advantages**: short-lived scoped tokens, per-installation repo selection, no manual repo-selection edits, better audit.
- **Disadvantages**: App registration, private-key handling, token minting step in the workflow.
- **Risks**: key compromise (mitigate: key in secret store only). **Justification**: addresses the largest credential blast radius. Interim: per-factory PAT.

## TD-05 Modular monolith for the Core; no microservices
- **Alternatives**: service per subsystem; serverless functions per feature.
- **Advantages**: one deploy, in-process calls, simpler consistency, fits a one-person team.
- **Disadvantages**: module discipline must be enforced (lint boundaries, tests).
- **Risks**: later extraction cost. **Justification**: no scaling evidence; modules are split by the boundaries in 02 so extraction stays possible.

## TD-06 Factories and agents as config-as-code in git, indexed in the DB
- **Alternatives**: DB-only configuration edited in UI.
- **Advantages**: review, history, rollback, diff for self-improvement (08), works with the existing `loadConfig` validation approach.
- **Disadvantages**: UI edits must produce commits/PRs (slower than DB writes).
- **Risks**: DB/git divergence (mitigate: git is the source of truth; DB is a derived index). **Justification**: aligns with "all changes version-controlled and auditable".

## TD-07 Move to a fresh sandbox per task
- **Context**: Boxes are reused; detached processes can leak across jobs (S3, README).
- **Alternatives**: keep scrub-and-verify; per-role dedicated Boxes.
- **Advantages**: removes the residual cross-job risk; enables parallelism beyond the static pool.
- **Disadvantages**: startup time and cost (snapshot restore); dependent on Upstash features (`Box.fromSnapshot` exists, `box.mjs:176-183`).
- **Risks**: Box limits (`boxLimit` 10) — needs queueing. **Justification**: strongest practical isolation; measure cost before committing.

## TD-08 Provider adapters with capability registry
Covered in 06. **Alternative**: keep per-agent shell commands. **Advantage of adapters**: usage tracking, failure classes, new providers without pipeline edits. **Cost**: one interface + conformance tests.

## TD-09 MCP introduced only when a concrete tool need exists, and only inside Boxes
- **Alternatives**: MCP from day one; ban MCP.
- **Justification**: MCP servers are third-party code with network reach; the first increment (skill packs via `jobFiles`) needs none (05).

## TD-10 Control-plane protected paths extend to the definitions repo
Extends `PROTECTED` (`guards.mjs:21`). **Advantage**: agents/improvers cannot alter safety rules. **Disadvantage**: legitimate changes need a human. Accepted by design.

## TD-11 Web UI stack decided in Phase 11, requirements fixed now
Requirements: typed client from OpenAPI, SSE support, AR/EN + RTL, deployable on hosting the owner already uses. **Why defer**: choosing a framework now adds no value and risks bias; the API contract is the real interface.

## TD-12 Reuse the existing Electron packaging for the Desktop app **(owner: confirm Electron vs. other)**
- **Context**: KingAgent already builds Electron installers (`electron-builder.yml`).
- **Alternatives**: Tauri; a PWA only.
- **Advantages**: known toolchain, existing signing/release workflow, Node integration for local tooling.
- **Disadvantages**: larger binaries, security hardening needed (context isolation, no remote content).
- **Risks**: Electron security misconfig (mitigate: checklist in Phase 12).

## TD-13 Treat all external text as untrusted; mandatory human review of every PR
Unchanged principle from the current README; extended to skills, MCP outputs and memory content. No autonomous merge.

## TD-14 Observability: append-only events + structured run records; no external APM initially
- **Alternatives**: adopt an APM/tracing vendor now.
- **Justification**: a table of run/usage/audit events satisfies every metric in the roadmap; add OpenTelemetry later if cross-service tracing is needed.
