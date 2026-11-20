# 18 — Automated Testing and Quality Assurance Architecture

Status: **partial**. The factory's own tests are strong at unit level; testing *of the software the factory produces* is only "run the repo's configured commands".

## 1. Verified state of the factory's own tests
| Fact | Evidence (2026-11-19, `main` @ `6cb7693`) |
|---|---|
| Linux CI (`Test` workflow, Node 24): **181 tests, 181 pass, 0 fail, 0 skipped** | `gh run view 44604013267 --log` |
| Local Windows 11, Node 24.19: 181 tests, **129 pass, 0 fail, 52 skipped** (all `test/pipeline.test.mjs`, skipped by design: need `setsid`) | `npm test` run for this audit; `test/pipeline.test.mjs:23-24` |
| One probabilistic test: `claim.test.mjs` "a race is usually won by someone, not lost by all" **failed once** (7/10 races had a winner) on the pre-merge branch under local load, passed on `main` and in CI | local run for this audit (`test/claim.test.mjs:55-62`) |
| No test touches a real Box or GitHub; real behaviour evidenced only by six real runs (01 §2) | `test/helpers.mjs`, `test/local-box.mjs` (stand-ins) |
| No end-to-end test of the factory in CI; no scheduled canary | `.github/workflows/` |

The flaky test violates "never rely on luck": its pass criterion is statistical. Fix in Phase 02-follow-up/03: make the claim race deterministic with a controlled scheduler, or quarantine with an explicit tracking issue.

## 2. Test levels for produced software
| Level | Who runs it | Source of the command |
|---|---|---|
| Unit | Box, `repos[].checks` | config (exists) |
| Integration / API | Box, service started by the supervised `run` entry | repo declaration (new `repos[].verify[]`) |
| E2E / UI | Box with Playwright (16 §5) | repo declaration |
| Build verification | Box; Windows verifier for Windows targets (16 §4) | config / template |
| Security | dependency audit, secret scan, SAST via repo tools; Security-role review | factory template |
| Regression | the repo's full suite + the failing-test-first rule for fixes | config |

## 3. Continuous validation workflow (prompt §12)
1. **Identify required tests** from the diff: start with all `checks` (exists); later a per-repo `testMap` (path glob → commands) to run affected tests first and the full suite last.
2. **Execute** in the executor; the *runner* records `{command, exit, duration, log_ref, log_sha256}` per step (extends `runScript` result).
3. **Analyse failures** via 17; create repair tasks within budget.
4. **Re-run**; compare against the pre-change baseline (was it already failing?).
5. **Verify the final state**: the last recorded run of every required command is green *after the final commit*; if a later commit exists, results are stale and invalid.
6. **Report** generated only from records (22 §6). Template shows: commands run, exit codes, skipped items with reason, flaky/quarantined items, what was **not** tested.

## 4. Anti-fabrication rules (enforced, not requested)
- A "passed" status exists only as a runner-written record. Agent prose, summaries and PR text are never a source (`buildPrBody` takes `checks` from config, `pr-body.mjs`, and states only commands that the pipeline ran).
- The PR/report generator refuses to render "tests passed" without a matching record for the head commit.
- Skipped tests are counted and shown with reason (this audit's 52 Windows skips are the model).
- Unit test of the report generator with a record set missing a command → output says "not run".

## 5. Test health management
Flaky test policy: a test failing intermittently in CI is quarantined within one cycle with an owner and issue; quarantined tests still run (non-blocking) and are reported. Statistical assertions are banned in unit tests (see §1).

## 6. Gaps and plan
| Gap | Phase |
|---|---|
| Deterministic claim-race test | 03 (with store/orchestrator tests) |
| Contract/schema tests for `task.v1`, `result.v1`, run record | 03 |
| Replay suite = six real-run scenarios as dry-run fixtures | 03–04 |
| Nightly canary issue against a sandbox repo (spends quota → owner approval) | 04, opt-in |
| Isolation negative tests (factory A cannot read B) | 07 |
| Injection fixtures for skills/MCP | 08 |
| Seeded-failure repos for 17 | 10 |

## 7. Acceptance (Phase 10, with early items earlier)
Verification records exist for every PR; stale-result rule demonstrated; fabrication test passes; flaky test count = 0 unquarantined; Linux CI and the Windows verifier both report counts that match the runner records.
