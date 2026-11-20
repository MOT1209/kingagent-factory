// The deterministic single-task planner of Phase 03 (docs/architecture/13 §5.4):
// one issue becomes one task, exactly the work runIssue does today. No LLM.
// The model stays null: today the CLI's own default is used (docs 15 §1).
import { createHash } from "node:crypto"
import { TASK_SCHEMA, validateTask } from "./contracts.mjs"

export function planSingleTask({ config, repo, issue, runId, forcedAgent = null }) {
  const minutes = config.factory.agentTimeoutMinutes ?? 25
  const task = {
    schema: TASK_SCHEMA,
    taskId: `${repo.repo}#${issue.number}@${runId}`,
    parentId: null,
    factory: config.factory.repo,
    project: repo.repo,
    role: "developer",
    objective: String(issue.title ?? "").trim() || `Issue #${issue.number}`,
    // Untrusted text: the prompt builder keeps its rule block above this.
    description: issue.body ?? "",
    complexity: null,
    assignedAgent: forcedAgent,
    assignedModel: null,
    provider: null,
    dependencies: [],
    authorizedTools: ["shell", "git-readonly"],
    budget: { minutes: minutes * 2, attempts: 2 },
    timeLimitMinutes: minutes,
    acceptance: [...repo.checks],
    requiredTests: [...repo.checks],
    status: "queued",
    idempotencyKey: createHash("sha256").update(`${repo.repo}#${issue.number}`).digest("hex").slice(0, 32),
  }
  const { ok, errors } = validateTask(task)
  if (!ok) throw new Error(`The planned task is invalid: ${errors.join("; ")}`)
  return task
}
