# Architecture documentation — index

Status of this set: **audit = verified against the repository on 2026-11-19 (`main` @ `6cb7693`); target architecture and roadmap = proposals awaiting owner approval.** Nothing under `docs/architecture/` describes implemented behaviour unless it cites a file, a test or a run.

Status vocabulary used everywhere: **implemented** (code and a test or real run), **partial**, **missing**, **planned**. Planned items are never presented as available.

## Where each requested topic lives
Existing Phase 01 files were kept and extended (no duplicates); new files fill genuine gaps. Reading order: 00, 01 §7, 13, 14, 15, 16, 10.

| # | Requested document | Location | State |
|---|---|---|---|
| 1 | CURRENT_SYSTEM_AUDIT | [01](01_CURRENT_SYSTEM_AUDIT.md) (**§7 = Revision 2**) | updated |
| 2 | TARGET_SYSTEM_ARCHITECTURE | [02](02_TARGET_SYSTEM_ARCHITECTURE.md) | updated (phase refs) |
| 3 | CENTRAL_FACTORY_CORE | [13](13_CENTRAL_FACTORY_CORE.md) | **new** |
| 4 | MULTI_AGENT_ARCHITECTURE | [04](04_MULTI_AGENT_ARCHITECTURE.md) (§10 added) | updated |
| 5 | DYNAMIC_AGENT_DELEGATION (four-sub-agent limit) | [14](14_DYNAMIC_AGENT_DELEGATION.md) | **new** |
| 6 | AI_MODEL_ROUTER (Main-Agent model authority) | [15](15_AI_MODEL_ROUTER.md) | **new** |
| 7 | PROVIDER_INTEGRATION_ARCHITECTURE | [06](06_AI_PROVIDER_ARCHITECTURE.md) | updated |
| 8 | REAL_EXECUTION_ENVIRONMENT (terminal, PowerShell, browser) | [16](16_REAL_EXECUTION_ENVIRONMENT.md) | **new** |
| 9 | MULTI_FACTORY_ARCHITECTURE | [03](03_MULTI_FACTORY_ARCHITECTURE.md) | updated (phase ref) |
| 10 | FACTORY_BUILDER | [03 §4](03_MULTI_FACTORY_ARCHITECTURE.md) | existing |
| 11 | SKILLS_AND_MCP_ARCHITECTURE | [05](05_SKILLS_AND_MCP_ARCHITECTURE.md) | updated (phase ref) |
| 12 | ERROR_DETECTION_AND_REPAIR | [17](17_ERROR_DETECTION_AND_REPAIR.md) | **new** |
| 13 | AUTOMATED_TESTING_ARCHITECTURE | [18](18_AUTOMATED_TESTING_ARCHITECTURE.md) | **new** |
| 14 | PROJECT_MANAGEMENT_ARCHITECTURE | [19](19_PROJECT_MANAGEMENT_ARCHITECTURE.md) | **new** |
| 15 | KNOWLEDGE_AND_MEMORY_ARCHITECTURE | [20](20_KNOWLEDGE_AND_MEMORY_ARCHITECTURE.md) | **new** |
| 16 | CONTROLLED_SELF_IMPROVEMENT | [08](08_SELF_IMPROVEMENT_ARCHITECTURE.md) | updated (phase refs) |
| 17 | SECURITY_AND_GOVERNANCE | [07](07_SECURITY_AND_GOVERNANCE.md) (§7 added) | updated |
| 18 | COST_AND_RESOURCE_MANAGEMENT | [21](21_COST_AND_RESOURCE_MANAGEMENT.md) | **new** |
| 19 | OBSERVABILITY_AND_ANALYTICS (+ automatic documentation) | [22](22_OBSERVABILITY_AND_ANALYTICS.md) | **new** |
| 20 | DEVELOPMENT_ROADMAP | [10](10_DEVELOPMENT_ROADMAP.md) | **rewritten (Revision 2)** |
| 21 | TECHNICAL_DECISIONS | [11](11_TECHNICAL_DECISIONS.md) (TD-15…21 added) | updated |
| 22 | RISK_REGISTER | [12](12_RISK_REGISTER.md) (R-33…43 added) | updated |
| — | Executive report | [00](00_FINAL_REPORT.md) | **new** |
| — | Web and Desktop | [09](09_WEB_AND_DESKTOP_ARCHITECTURE.md) | **deferred by owner** |

File names keep the numbered Phase 01 convention rather than the long names in the assignment, to avoid breaking existing cross-references; the table above is the mapping.
