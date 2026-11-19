# 20 — Knowledge and Memory Architecture

Status: **missing**. Today an agent starts every task with no memory: context = issue text, trusted comments and the repo's own instruction files (`pipeline.mjs:21-50`, `guards.mjs:40 trustedComments`). `agents.*.jobFiles` can copy a house `CLAUDE.md`/`AGENTS.md` into the Box (`agents.mjs:136`), but none is configured. The summary in 02 §5 is the starting point; this document is the full design.

## 1. Scopes and boundaries
| Scope | Contains | Readable by | Writable by |
|---|---|---|---|
| **Global factory** | distilled, project-agnostic knowledge: tool quirks, image facts, proven prompts | all factories (read) | improvement pipeline after human approval only |
| **Factory-specific** | conventions, templates, decisions of one factory | that factory's agents | that factory's Main Agent, Documentation role |
| **Project** | repo analysis, architecture notes, how to run/test, known pitfalls | agents of tasks in that project | Analyst/Documentation roles; Main Agent |
| **Agent** | role-local notes (scratch, preferences) | that agent role in that factory | that agent role |
| **Task history** | per task: contract, steps, evidence, outcome | project's Main Agent; auditors | orchestrator (append-only) |
| **Technical decisions** | ADRs with context/alternatives/status | factory agents; humans | proposal → human approval |
| **Lessons learned** | repeat-failure patterns with evidence | improvement pipeline; Main Agent | derived by analysis (22), reviewed |

**Hard rules:** no scope is readable outside its boundary without an explicit, recorded grant; global memory never contains raw project content (only distilled, de-identified facts); every record carries `factory_id` and, where applicable, `project_id`; enforcement is in the data layer (row-level security / per-scope namespaces) and tested with negative tests, not only in application code.

## 2. Record model
`{id, scope, factory_id, project_id?, kind, body, source{type: run|commit|issue|human|analysis, ref, retrieved_at}, trust: verified|unverified, version, supersedes?, created_by, created_at, retention_until?, deleted_at?}`.
- **Source tracking**: no record without `source`; "verified" only when backed by runner evidence (e.g. a command and its exit code) — otherwise `unverified` and shown as such to agents.
- **Versioning**: append-only; an update creates a new version that `supersedes` the old; history retained until retention expiry.
- **Untrusted content**: memory text injected into an agent's prompt is placed in the data section, below the rule block, like issue text (`buildPrompt`); it cannot carry instructions with authority (prompt-injection defence, 07 §4).

## 3. Storage and retrieval (staged, no new tech before need)
1. **Stage 1 (Phase 11 start)**: records in the Core store (Postgres, TD-03) + markdown exports into the repo's factory definition for human review; retrieval by structured filters (scope, project, kind, recency) and full-text search. No vectors.
2. **Stage 2 (only if retrieval quality is measured as insufficient)**: add an embedding index *per scope* (never a shared index across projects), built from the same records; deleting a record deletes its vectors.
3. Retrieval API returns at most K records with sources; the caller's grants are checked in the query, not afterwards. Retrieved items are budgeted into the prompt (cost, 21).

## 4. Retention, backup, deletion
- **Retention** per scope and kind in factory config; task history default 90 days (matches today's artifact retention, `factory.yml` `retention-days: 90`); decisions and lessons kept until superseded.
- **Backup/recovery**: store-level point-in-time recovery; scheduled restore drill (Phase 13). Git-exported memory gives a second, human-readable copy.
- **Authorised deletion**: a `factory-admin` request with reason; removes records, derived indices (vectors, exports) and logs a tombstone (what/when/who, not content). A project's removal deletes its project and agent scopes in one operation; global memory is unaffected because it holds no project content.

## 5. What agents may do
Read: scopes granted by role manifest (`memory.read`, 04 §2). Write: only the scopes in `memory.write`; a write is a proposal record (`unverified`) until verified or approved. An agent can never widen its own grants, and sub-agents write only to task history via their result.

## 6. Risks
Memory poisoning (a malicious issue writes "lessons") → writes from tasks are `unverified`, never reach global scope without human approval; cross-project leakage → separate namespaces + negative tests; stale knowledge → `retrieved_at` and base-SHA stamp, re-validate on mismatch; cost of long contexts → K-limit and token budget.

## 7. Acceptance (Phase 11)
Cross-scope and cross-factory read attempts fail (negative test suite); an unverified record is labelled in prompts; supersede keeps history; deletion removes records, exports and any index and leaves a tombstone; a restore drill recovers a project's memory; global memory scan finds no repository content.
