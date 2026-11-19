# 19 — Project Management Engine

Status: **missing** (design only). Today the "project" is a GitHub issue; one issue → one task → one PR. There is no repository analysis, requirements model, roadmap generation, dependency graph or progress tracking beyond issue labels (`issue-state.mjs`). The only decomposition aid is the agent's `NEEDS_SPLIT:` reply, which a human turns into issues (`pipeline.mjs:259-262`).

## 1. Scope (prompt §13) and where each capability lands
| Capability | Design |
|---|---|
| Project creation | `project` record = {factory, repo(s), base branch, `setup`/`checks`, limits, owner}. Generalises `factory.config.json repos[]`. |
| Repository analysis | Read-only **Analyst** task on a Box: languages, build/test commands, layout, entry points, size, existing CI, conventions files (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` — the pipeline already tells agents to follow these, `pipeline.mjs:44`). Output stored as project memory (20) with source references. Untrusted repo content: analysis output is data, validated against a schema. |
| Requirements analysis | Intake normalises an issue/epic into `{goal, constraints, acceptance[], unknowns[]}`; unknowns trigger a clarification (existing marker `NEEDS_CLARIFICATION`) instead of guessing. |
| Architecture planning / roadmap | Architect-role task produces a plan document and a DAG of tasks as a **pull request against the app repo** (reviewable text), never directly executed. |
| Task decomposition + dependencies | Planner emits tasks as `task.v1` (below) with declared dependencies; the orchestrator validates a DAG (14). Humans approve the plan before execution (configurable per factory; mandatory at first). |
| Agent assignment | Role from the task type; model tier by the router (15); both set by the Main Agent, validated by policy. |
| Progress monitoring, blockers | Task states + heartbeat (04). Blocker = `NeedsInput` older than N, failed dependency, budget >80% used, repeated failure class (17). Surfaced by comment on the issue and in the CLI report — no UI. |
| Prioritisation | Ordered by dependency, then declared priority, then age; fairness across projects within the factory's concurrency cap (21). |
| Cost tracking, quality evaluation | From run records (21, 22): minutes, attempts, first-try check pass, human-edit rate after PR. |
| Reporting | Generated from records (22 §6): per-project status, what is verified, what is blocked. |

## 2. Task contract (every field required by the prompt)
Extends `task.v1` in 04 §3 (which already has id, parent, role, goal, constraints, inputs, acceptance, budget, idempotency).

| Field | Meaning | Set by |
|---|---|---|
| `task_id`, `parent_id` | identity, hierarchy (depth ≤ 1 below Main) | orchestrator |
| `objective`, `description` | one-line aim; detail (**untrusted text**) | planner / human |
| `complexity` | simple / medium / difficult / highly-complex + `score`, `reasons[]` | router (15) |
| `assigned_agent` (role + instance id) | who | Main Agent |
| `assigned_model`, `provider` | what runs it | Main Agent only (15) |
| `dependencies[]` | task ids that must be `succeeded` | planner, validated |
| `authorized_tools[]` | e.g. `shell`, `git-readonly`, `pwsh`, `browser` | policy from role |
| `budget` | `{minutes, usd?, attempts}` | policy, carved from parent |
| `time_limit` | wall-clock deadline | policy (today `agentTimeoutMinutes`) |
| `acceptance_criteria[]` | testable statements | planner / human |
| `required_tests[]` | commands/ids that must pass (18) | planner from `testMap` |
| `status` | state machine in 04 §4 | orchestrator only |
| `results` | `result.v1`: artifacts, summary, usage, evidence | runner |

## 3. Minimal first slice (Phase 09, builds on 03–04)
1. Convert `NEEDS_SPLIT` output into **draft issues** (comment with a checklist the owner can accept); an accepted list creates real issues labelled with dependencies (`depends-on: #n` in body, parsed and validated).
2. An epic issue (`epic` label) triggers the Analyst + Architect tasks; the plan is opened as a PR; execution only after merge/approval.
3. Dependency-ordered execution: a dependent issue's `ready` is applied by the orchestrator only when its prerequisites reached `factory:review` and were merged by a human — **the factory still never merges**, so "dependency met" means "merged by a person".

## 4. Risks and controls
Automatic decomposition quality is unproven → human approval gates plus dry-run first; prompt injection via epic text → planner output validated against schema and constraints, tool grants from role not from text; runaway plan size → cap on tasks per epic and on total budget; stale plans → plan records the base SHA and is re-validated when it changes.

## 5. Acceptance (Phase 09)
A fixture epic is decomposed into a valid DAG; invalid (cyclic, over-budget, too many tasks) plans are rejected; execution follows dependency order across at least three issues in a sandbox repo; blocker detection fires for seeded cases; a project report lists only facts present in records.
