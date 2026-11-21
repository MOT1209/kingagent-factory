# 12 — Risk Register

Scales: **Probability** L/M/H · **Impact** L/M/H · **Severity** = rough product (Low/Medium/High/Critical). Owner for all = project owner unless stated. Evidence refers to 01/07.
`Status`: Open · Mitigating · Accepted. Reviewed at the end of every phase.

## Technical

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-01 | **Monolithic `runIssue`** makes roles/DAGs hard to add safely (F-D2) | H | M | High | Stage extraction guarded by existing tests (Phase 04); strangler wrapper (Phase 03) | Size of `pipeline.mjs`; test count green |
| R-02 | **Label-order race** picks the wrong agent or none (F-D1) | M | M | Medium | T02-2 (gate or re-read) + documented order | Run records: `agent` vs label at dispatch time |
| R-03 | **No durable run history**; improvement/cost/UI impossible (F-D3) | H | M | High | T02-4 records, Phase 03 store | % runs with record |
| R-04 | **Windows dev test run unreliable** (23 timeouts; 38 tests unaccounted for) hides regressions locally | H | L | Medium | T02-5 | Local vs CI count parity |
| R-05 | **`@upstash/box` API/behaviour change** (single critical dependency, `^0.8.0`) breaks claiming/transfers | M | H | High | Pin + Dependabot + contract tests on `box.mjs`; `Sandbox` interface | Dependabot PRs, smoke test before bumps |
| R-06 | **Claim correctness assumes consistent label lists** (README) — two runs could share a Box | L | H | Medium | Verify under concurrent load in Phase 04; fallback to a DB lock (Phase 03) | Collisions in run records |
| R-07 | **Static worker pool** limits concurrency; `no-worker` outcomes | M | M | Medium | Fresh-Box-per-task + queue (TD-07) | `no-worker` rate, wait time |
| R-08 | **Admin scripts act on all repos, no retries** (F-D5) — partial setup on network failure | M | M | Medium | T02-3 | Script exit/partial reports |
| R-09 | **Stale/incorrect documentation** misleads operators (F-Q2) | H | L | Medium | T02-1; docs checks in CI | Doc review at phase end |

## Security

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-10 | **Prompt injection** via issue/comment/repo/skill leads to harmful code or data leak in Box (S1) | M | H | High | Defence in depth (07); injection fixtures; mandatory PR review; no credentials in Box | Guard hits, fixture pass rate, PR review findings |
| R-11 | **Shared PAT compromise** → write to all app repos (S2) | L | H | High | GitHub App per factory (TD-04); least scope; rotation | Token usage anomalies, audit log |
| R-12 | **Cross-factory data/secret leakage** once multi-factory exists | M | H | High | Per-factory namespaces, RLS, negative tests (Phase 07) | Isolation test suite in CI |
| R-13 | **Malicious/compromised skill or MCP server** | M | H | High | Untrusted-by-default lifecycle, quarantine, egress allow-list (05) | Extension audit log, new-version alerts |
| R-14 | **Token exposed in chat during setup** (S6) — a GitHub token was pasted into a conversation and is stored as the current secret | H (already occurred) | H | **High** | **Rotate now**: create new fine-grained token, update `.env`, run `set-secrets --yes`, revoke old; runbook | Verify old token revoked; GitHub audit log |
| R-15 | **Extra Claude workflows on the control-plane repo** (S4) | L | M | Low–Med | Review triggers/permissions; restrict or remove | Workflow run list on `claude.yml` |
| R-16 | **Detached process leaks across reused Box** (S3) | L | M | Medium | Fresh Box per task | Scrub verification failures |
| R-17 | **Self-improvement weakens safety** | L | H | Medium | Control-plane protection, isolated evaluation, approvals, canary + rollback (08) | Safety-metric regression gate |
| R-18 | **Supply chain** (npm deps, Actions by tag, worker image installs `opencode-ai` globally, `worker/setup.sh:43`) | M | H | High | SHA pinning, Dependabot, lockfile review, image build provenance | Dependabot alerts, `npm audit` |

## Operational

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-19 | **Single operator, flaky local network** (`TLS handshake timeout` seen during setup) interrupts admin work | M | L | Low | Retries/timeouts (T02-3); run admin tasks in Actions where possible | Script failure logs |
| R-20 | **Run killed mid-way** leaves issue `running` / Box claimed | M | M | Medium | Existing recovery + 3-hour sweep (`recover.mjs`, `reap.yml`) | Stale-claim advice in `ops.mjs`, status |
| R-21 | **Lost runner** delays recovery until next run (README) | L | M | Low | Scheduled sweep exists | Time-to-recover metric |
| R-22 | **Bus factor / knowledge concentration** | M | M | Medium | These docs, runbooks, factory-produced PRs reviewed | — |

## Financial

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-23 | **No spend/minute budgets**: a burst of `ready` labels burns provider quota, Actions minutes, Box time (S8) | M | M | Medium | Caps in config (T02-7), budgets (Phase 07) | Minutes/day per repo |
| R-24 | **Subscription CLIs hide token/cost data**; estimates may be wrong | H | L | Medium | Label estimates; track minutes/requests; never invent numbers | % runs with usage `unknown` |
| R-25 | **Postgres/hosting and Box costs grow** with factories | M | M | Medium | Resource limits per factory; cost review each phase | Monthly cost dashboard |

## Infrastructure and scalability

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-26 | **Box limit (10) and per-box label limit (5)** cap concurrency (`config.mjs`, `box.mjs:245`) | M | M | Medium | Pool design, queueing, per-factory limits | Boxes in use vs limit |
| R-27 | **Job time ceiling 175 min** vs larger multi-step tasks (`factory.yml`) | M | M | Medium | Task decomposition (Phase 09); long-running execution outside Actions if needed | Run durations |
| R-28 | **GitHub API/Actions rate limits and outages** | M | M | Medium | Existing retry/backoff (`github.mjs`); queue in Core | Rate-limit headers, failed dispatches |

## Provider dependency

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-29 | **Provider limits/outages** (weekly limit seen in README/stage-04) block work | H | M | High | Failover exists (one retry, `pipeline.mjs:224`); adapters + circuit breaker (Phase 07) | Failure classes per provider |
| R-30 | **Vendor lock-in** (CLI auth quirks in config) | M | M | Medium | Provider adapters; neutral task contract | Adapter coverage |

## Data isolation and quality

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-31 | **Memory poisoning / leakage**: untrusted content stored as knowledge influences later runs or crosses projects | M | H | High | Scope tags, provenance, validation before write, global memory limited to distilled facts (02 §5) | Memory write audit, cross-scope read tests |
| R-32 | **Per-repo setup/check misconfiguration** (e.g. checks needing env/services) makes runs fail on newly added repos — 7 repos were added from `package.json` inspection only | H | L | Medium | First-run smoke per repo; `repos[].secrets` for required env | `needs-attention` rate per repo |

## Top actions (ordered)
1. **R-14** rotate the exposed token (now).
2. R-18/R-15 supply-chain and control-plane workflow review (Phase 02).
3. R-02 label-order race and R-03 run records (Phase 02).
4. R-11 GitHub App migration planning (before multi-factory).

---

## Additions and status updates — Revision 2, 2026-11-19
Status changes since Phase 01: **R-02** label-order race → *Mitigating* (settle wait, `pipeline.mjs:121`; late labels are still missed). **R-03** no run history → *Mitigating* (JSON run record artifact; no store yet). **R-14** exposed token → *Open*, no evidence of rotation. **R-15/R-18** → *Mitigating* (Actions pinned to SHAs, `claude.yml` gated; `claude-code-review.yml` not gated). **R-23** no budgets → *Open* (T02-7 not delivered).

| ID | Risk | P | I | Sev | Mitigation | Monitoring |
|---|---|---|---|---|---|---|
| R-33 | **Sub-agent cap bypass** (forged spawn, slot leak, race) allows more than 4 active agents and uncontrolled cost | M | H | High | Atomic slot CAS, lease + reaper, capability tokens, property/simulation tests (14) | slot utilisation, `policy.denial` events |
| R-34 | **Main Agent manipulated by untrusted issue/epic text** (inflated plan, expensive tier, widened scope) | M | H | High | Deterministic policy validation of every proposal; deterministic complexity scorer; caps on tasks, tier and budget (13, 15) | rejected-proposal rate |
| R-35 | **Parallel subtask conflicts** (same files, merge conflicts) corrupt the integrated change | M | M | Medium | Path locks, DAG, integration on the runner, guards on the integrated diff (14 §4) | integration failure rate |
| R-36 | **Per-task model selection unsupported by the CLIs** (01 N4) — router plan blocked | — | — | **Resolved 2026-11-21** | `scripts/probe-models.mjs` verified a per-task model on both CLIs: Claude Code 2.1.293 `--model` (haiku, sonnet, opus), OpenCode 1.18.29 `-m` (opencode/big-pickle, opencode/deepseek-v4.1-flash-free); in each case the CLI's own report names the requested model as the one that answered (15 §6) | re-probe after image rebuilds |
| R-37 | **Windows verifier cost/abuse** (minutes multiplier, untrusted code on a runner) | M | M | Medium | Minute caps, no credentials, patch-only input, ephemeral VM (16, 21) | verifier minutes |
| R-38 | **Browser tests of untrusted pages without egress control** (data exfiltration, internal reach) | M | H | High | Feature gated on an enforceable allow-list; localhost-only default (16 §5) | egress denials |
| R-39 | **Flaky statistical test** erodes trust in CI and hides real races (observed: `claim.test.mjs`, 7/10 once) | M | M | Medium | Deterministic rewrite or quarantine with an owner (18 §5) | unquarantined flaky count = 0 |
| R-40 | **High-severity `zod` advisory** left unpatched | L | M | Medium | TD-21 PR | `npm audit` in CI |
| R-41 | **`claude-code-review.yml` unrestricted on same-repo PRs** with `id-token: write` | L | M | Medium | Review triggers; gate by actor like `claude.yml` | workflow test |
| R-42 | **Documentation drift** (README claimed "no end-to-end run" after six; roadmap renumbering) | M | L | Low | Doc tests, status vocabulary (22 §6), phase map in 10 | doc-test failures |
| R-43 | **Unverified assumptions treated as facts** (Upstash egress, CLI flags, pwsh/Playwright on ARM64) | M | M | Medium | Each is a named first task with a probe and a recorded result (15 §6, 16) | probe registry |

### Top actions (revised order)
1. **R-14** token rotation (owner, GitHub UI) — the only open process-critical item.
2. TD-21 `zod` PR; gate `claude-code-review.yml` (R-40, R-41).
3. T02-7 caps (R-23) and a deterministic claim-race test (R-39, R-06).
4. Phase 03 store + run records → unlocks R-03, R-23, R-33.
5. Phase 05 capability probes (R-36, R-43) before any router code.
