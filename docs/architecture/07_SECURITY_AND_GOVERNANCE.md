# 07 — Security and Governance

Status: **current-state findings (verified from code) + target model (proposal)**. Security is a foundation, not a phase-13 feature: items marked *Phase 02* are cheap and should land first.

## 1. Threat model (what we defend against)

| Asset | Threat | Source |
|---|---|---|
| GitHub write token (`FACTORY_GITHUB_TOKEN`) | Theft, over-broad use | Compromised Box/agent, any repo workflow holding the secret, leaked paste |
| Provider credentials (Claude OAuth, OpenCode auth) | Theft from the Box | Manipulated agent, residual process |
| Repo contents / other projects | Cross-project access | Agent, extension, factory misconfiguration |
| Control plane (workflows, CODEOWNERS, factory config) | Tampering | Agent patch, self-improvement, PRs |
| Budgets | Cost burn | Spam issues, loops |
| Agent behaviour | Prompt injection via issue/comment/repo file/skill | Any untrusted text |

Trust boundaries: **runner = trusted** (holds credentials, applies patches); **Box = untrusted** (agent, repo code, tests); **issue/comment/repo/skill/MCP text = untrusted input**.

## 2. What exists today (verified)

| Control | Evidence |
|---|---|
| Token never in the Box; git runs on the runner with the token as a header in env, not URL/`.git/config`; hooks off; reduced env (`cleanEnv`) | `git-host.mjs:20-41`, `pipeline.mjs:3-6` |
| Patch decided on the runner from the Box's diff; protected paths (`.github/` any case, `CODEOWNERS`, `.git`) never pushed, also through renames | `pipeline.mjs:260-275`, `guards.mjs:21-22`; tests in `test/guards.test.mjs`, `pipeline.test.mjs` |
| Size/shape review: >100 files or >5000 lines, lockfile-only, test-deletion-only refused | `guards.mjs:56-77` |
| Only `allowedActors` start runs (trigger `if`) and manual dispatch is checked again | `templates/factory-ready.yml`, `pipeline.mjs:81-83` |
| Only allowed actors' comments reach the agent | `guards.mjs:40-43` |
| Issue number validated before use in API paths | `pipeline.mjs:94` |
| Secrets passed to workflow steps by name; none in `npm ci` step; enforced by tests | `.github/workflows/factory.yml`, `test/workflow.test.mjs` |
| Secret masking in comments/PR text/logs (including multi-line) | `guards.mjs:27-36`, `github.mjs:34-38` |
| Sign-in removed right after the agent; work dir scrubbed and **verified**; unclean Box stays claimed | `agents.mjs:78-97`, `pipeline.mjs:299-313` |
| Branch overwrite guard (`Factory-Run:` trailer) and `--force-with-lease` | `guards.mjs:6-10`, `git-host.mjs:117-119` |
| Checksummed transfers; 50 MB patch cap | `box.mjs:289-318` |
| Workflow permissions `contents: read`, `actions: read`; checkout without persisted credentials | `factory.yml:18-21, 45-46` |
| Never merges; never edits branch protection | README "Security notes" |

## 3. Findings (gaps), ranked

| ID | Severity | Finding | Fix direction |
|---|---|---|---|
| S1 | High | Agent has full permissions in the Box (`--dangerously-skip-permissions`, passwordless sudo). Prompt injection explicitly unsolved. | Keep the Box boundary; add fresh-Box-per-task, egress allow-list if supported, secret-less test environment, PR review remains mandatory. |
| S2 | Medium | One PAT with write on every app repo, stored as a secret in each. | GitHub App with per-installation tokens, short-lived, per-factory scope; interim: fine-grained PAT per factory. |
| S3 | Medium | Cross-job leakage via detached processes in a reused Box. | Fresh Box per task (snapshot restore). |
| S4 | Medium | `claude.yml`/`claude-code-review.yml` on the factory repo use `CLAUDE_CODE_OAUTH_TOKEN` with `id-token: write`. | Review triggers/permissions; restrict to collaborators; consider removing from the control-plane repo. *Phase 02.* |
| S5 | Low | Actions pinned to tags. | Pin to SHAs via Dependabot. *Phase 02.* |
| S6 | Process | A token was pasted into a chat during setup and is now a stored secret. | Rotate; add "never paste tokens" to runbook. *Do now.* |
| S7 | Medium | No authentication/authorization model beyond GitHub identity; no audit log other than issue comments and Actions logs. | RBAC + append-only audit (target). |
| S8 | Medium | No spend/rate limits per user or repo; a flood of `ready` labels by an allowed actor can burn the provider quota (a run per issue). | Budgets and per-repo concurrency caps (06). |

## 4. Target model

### Authentication
Web/Desktop users sign in with GitHub OAuth (single identity provider initially); sessions are short-lived; the Desktop app uses the device flow and stores tokens in the OS keychain. Service-to-service: signed tokens with audience and short TTL. No shared static admin password.

### Authorization (RBAC + scopes)
Roles: `owner`, `admin`, `operator`, `reviewer`, `viewer`. Scopes: platform → factory → project. Permissions are explicit verbs on resources (e.g. `factory:create`, `skill:enable`, `task:approve`, `budget:edit`). Default deny. Decisions are made by one policy module; clients never decide.

### Isolation
Per-factory: Box pool, secret namespace, GitHub credential, memory scope, tool allow-list (03). Verified by **negative tests**: a task in factory A must fail to read factory B's secret, repo, memory.

### Sandboxing
Runner/Box split (existing). Add: fresh Box per task; resource limits (CPU/mem/disk/time) per role; egress policy where supported (to verify with Upstash); no secrets in test environment unless declared (`repos[].secrets` exists, `agents.mjs:123-133`).

### Secrets
Stored only in the platform secret store/GitHub secrets, referenced by name, delivered just-in-time to the component that needs them, never written to the store or logs, rotated on a schedule. Rotation runbook and a "break glass" revoke.

### Prompt-injection defences (defence in depth; none is a guarantee)
1. Separate trusted instructions from untrusted task text (existing rule block above the issue, `pipeline.mjs:36-48`).
2. Only trusted comments forwarded (existing).
3. Capability limits instead of trusting the model: protected paths, size limits, no credentials in the Box (existing).
4. Fixture suite of injection attempts run against every agent/skill/model change (new, 08).
5. Mandatory human review of every PR; certain classes (dependency, config, CI) flagged for a second reviewer.

### Human approvals
Approval Center: budget overrides, enabling a new extension, activating a factory version, any self-improvement proposal touching the control plane, first use of a new provider. Each approval is a signed, audited record with the diff/evidence attached.

### Audit
Append-only log: actor, action, resource, before/after hash, timestamp, request id. Covers admin operations, tool calls (05), approvals, secret access events (names only), and run outcomes.

### Incident response and rollback
Runbooks: leaked token (revoke → rotate → `set-secrets`), runaway cost (disable factory → drain), suspicious PR (close, audit run, review Box). A **kill switch** = existing `FACTORY_DRY_RUN` variable (`factory.yml:57,78`) extended to per-factory/per-repo. Rollback of factory/agent/skill versions = re-pin previous version (03, 05). Backups: Postgres PITR + definitions in git.

### Dependency security
Dependabot (exists) + `npm audit` in CI as a non-blocking report first; lockfile-only change refusal exists (`guards.mjs:70`).

## 5. Governance rules (platform invariants)
1. No component may modify its own permission boundary or the policy engine (08).
2. Control-plane paths are protected like `.github/` today and extended to the factory definitions repo.
3. Every outbound write (PR, comment, label) is attributable to a run id.
4. Nothing merges or deploys without a human.

## 6. Acceptance (Phase 13, with early items in Phase 02)
Rotation drill passes; cross-factory negative tests pass; injection fixture suite stable; audit log complete for a scripted scenario; S1–S8 each closed or accepted in writing.
