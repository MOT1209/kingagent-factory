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

---

# Additions — 2026-11-19 (master engineering prompt)
Format per decision: problem · existing solution · proposed · alternatives · pros · cons · migration impact · cost · security · maintenance.

## TD-15 Defer the Web and Desktop applications **(owner decision, recorded)**
- **Problem**: the earlier plan scheduled a Web Control Center and a Desktop app (phases 11–12 of the old roadmap). **Existing**: GitHub labels/comments, Actions summaries, CLI scripts — adequate for today's single operator.
- **Proposed**: remove both from the critical path; keep 09 as a future note; keep the Core API UI-agnostic. **Supersedes the scheduling of TD-11 and TD-12** (their content stays valid if reversed).
- **Alternatives**: build a read-only dashboard first. **Pros**: focus on the engine; no second product to secure. **Cons**: no visual monitoring; the operator relies on CLI/GitHub. **Migration**: none. **Cost**: saves UI build and upkeep. **Security**: removes a large attack surface for now. **Maintenance**: none.

## TD-16 The Main Agent proposes; deterministic code validates and enforces
- **Problem**: "central authority" must hold even if the Main Agent is manipulated by untrusted issue text. **Existing**: no Main Agent; policy is code (`guards.mjs`, `config.mjs`).
- **Proposed**: an LLM-assisted Main Agent emits plans and tier requests; a deterministic policy engine and orchestrator validate every proposal and are the only writers of agent instances, models and budgets (13 §1).
- **Alternatives**: fully LLM-controlled orchestration (rejected: not testable, injectable); fully static plans (rejected: no dynamic delegation). **Pros**: testable invariants; injection cannot raise limits. **Cons**: more code; planner flexibility limited to what policy allows. **Migration**: additive. **Cost**: engineering time; one extra LLM call per plan. **Security**: the key control on prompt-injection blast radius. **Maintenance**: policy tests.

## TD-17 Slot ledger by atomic store operation, not by Box labels
- **Problem**: enforce `active ≤ 4` per parent. **Existing**: worker claim via Box labels, correctness assumed (`box.mjs:198-203`, risk R-06).
- **Proposed**: conditional update (compare-and-set) in the Core store + lease/heartbeat + reaper (14 §3). **Alternatives**: in-process semaphore (loses state on crash, single process only); label-based slots (same unverified assumption). **Pros**: provable under concurrency; survives restarts. **Cons**: needs the Phase 03 store first. **Migration**: interim = in-process semaphore + the existing `concurrency` group, behind the same interface. **Cost**: none beyond the store. **Security**: prevents resource exhaustion by forged spawns. **Maintenance**: the reaper.

## TD-18 Per-task model assignment rendered by the orchestrator from a probe-verified registry
- **Problem**: choose models per task without trusting agents or assuming availability. **Existing**: CLI default model fixed per Box by `boxSettings` (`box.mjs:86-114`).
- **Proposed**: tier→model registry with `verified_at`; the orchestrator renders the agent command/settings per job; a capability probe extends `scripts/smoke-test.mjs` (15). **Alternatives**: keep per-Box models and route by Box (coarse, wastes Boxes); let the agent pick (violates M-1). **Pros**: auditable, cost-aware. **Cons**: depends on CLI support for per-job model selection (**unverified**). **Migration**: `boxSettings` stays as the default. **Cost**: probe quota. **Security**: an agent cannot influence its own model. **Maintenance**: re-probe on image rebuild.

## TD-19 Windows execution: ephemeral GitHub-hosted `windows-latest` verifier; PowerShell 7 added to the Linux image
- **Problem**: real PowerShell and Windows builds; Boxes are Linux ARM64. **Existing**: none.
- **Proposed**: a verifier job (patch in, evidence out, no credentials) plus `pwsh` in `worker/setup.sh` (installation to be verified by the image's own check step) (16 §4). **Alternatives**: self-hosted Windows runner/VM (more control, more risk and operations); run everything on Windows (loses the Box isolation model). **Pros**: no new infrastructure, fresh VM per job. **Cons**: Actions minutes (Windows multiplier), cannot host the agent. **Migration**: a new workflow job; the existing flow is untouched. **Cost**: minutes (to be measured). **Security**: same credential boundary. **Maintenance**: runner image drift.

## TD-20 Browser automation by Playwright over CDP to the Box's managed Chromium (fallback: Playwright-managed browser)
- **Problem**: real browser testing. **Existing**: Chromium enabled and started, no automation tool installed (01 N3).
- **Proposed**: Playwright connects over CDP to port 9222; a spike first, acceptance in 16 §8. **Alternatives**: `agent-browser` (mentioned in `box.mjs:154`, unverified), Puppeteer, a bundled Chromium in the image (bigger image). **Pros**: no browser download; standard API for screenshots, console and network. **Cons**: CDP-attach stability unverified; egress control unverified (a gate). **Migration**: the image gains a dependency. **Cost**: image size. **Security**: allow-list egress or the feature stays off. **Maintenance**: pin the Playwright version.

## TD-21 Resolve the `zod` high advisory through a normal dependency PR
- **Problem**: `npm audit --omit=dev` reports 1 high (transitive via `@upstash/box`). **Existing**: the lockfile resolves a vulnerable version; Dependabot watches npm.
- **Proposed**: a lockfile update (`npm audit fix`) in a reviewed PR with the full tests; `overrides` only if upstream lags. **Alternatives**: accept the risk (exploitability for a CLI that validates SDK data was **not assessed in depth**). **Cost**: minutes. **Not applied in this assignment** (no dependency changes before approval).
