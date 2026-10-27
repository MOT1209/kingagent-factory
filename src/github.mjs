// Small GitHub REST helper. Uses FACTORY_GITHUB_TOKEN, the fine-grained token
// that can reach the app repos.
const API = "https://api.github.com"

// Every comment the factory writes carries this hidden marker, so its own
// comments can be told apart from a person's, even when both use one account.
const FACTORY_MARK = "<!-- software-factory -->"

// The comment that says a worker took the issue also names the run, so a
// recovery can tell whether the issue is still in that run's hands.
const RUN_MARK = /<!-- factory-run:(\S+) -->/
export const runMark = (runId) => `<!-- factory-run:${runId} -->`

// The run that most recently took the issue, from the factory's own comments.
export function ownerRun(comments) {
  for (const c of [...comments].reverse()) {
    const match = c.body?.includes(FACTORY_MARK) && RUN_MARK.exec(c.body)
    if (match) return match[1]
  }
  return null
}

// Tests swap in a fake fetch and a sleep that does not wait.
export const transport = { fetch: (...args) => fetch(...args), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

// A GitHub error with the status, and a sentence on what usually causes it.
export class GitHubError extends Error {
  constructor(method, path, status, text) {
    super(`GitHub ${method} ${path} failed: ${status} ${String(text).slice(0, 500)}\n${hintFor(status, text)}`)
    this.status = status
  }
}

export function hintFor(status, text = "") {
  if (status === 401) return "The token is invalid or expired. Make a new one and update FACTORY_GITHUB_TOKEN."
  if (status === 403 && /rate limit/i.test(text)) return "GitHub's rate limit. It resets by itself; retry later."
  if (status === 403) return "The token lacks a permission for this call, or the repo is not in its repository selection (see the README's permission table)."
  if (status === 404) return "Not found, or the token cannot see it. GitHub answers 404 for private repos the token has no access to."
  if (status === 409) return "Conflict: the branch or ref changed meanwhile."
  if (status === 422) return "GitHub refused the request as invalid (for example a pull request with no difference, or a duplicate)."
  if (status >= 500) return "GitHub had a server error. Retry later."
  return ""
}

// Rate limits and server errors are worth a short retry. Nothing else is: a
// 403 for a missing permission does not get better by asking again.
export function isTransient(status, text = "", headers = new Map()) {
  if (status >= 500 || status === 429) return true
  return status === 403 && (/secondary rate limit|rate limit exceeded/i.test(text) || headers.get?.("x-ratelimit-remaining") === "0")
}

// `token` overrides FACTORY_GITHUB_TOKEN, for the workflow's own GITHUB_TOKEN.
export async function github(path, { method = "GET", body, token = process.env.FACTORY_GITHUB_TOKEN } = {}) {
  if (!token) throw new Error("FACTORY_GITHUB_TOKEN is not set")

  for (let attempt = 1; ; attempt++) {
    let response
    try {
      response = await transport.fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (error) {
      // A network failure. GET is always safe to repeat; a write is only
      // repeated when it never reached GitHub.
      if (attempt < 3 && (method === "GET" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(error.cause?.code ?? error.message)))) {
        await transport.sleep(1000 * attempt)
        continue
      }
      throw new Error(`GitHub ${method} ${path} could not be reached: ${error.message}`)
    }
    if (response.ok) return response.status === 204 ? null : response.json()

    const text = await response.text()
    if (attempt < 3 && isTransient(response.status, text, response.headers)) {
      const wait = Number(response.headers.get?.("retry-after")) * 1000 || 2000 * attempt
      await transport.sleep(Math.min(wait, 60_000))
      continue
    }
    throw new GitHubError(method, path, response.status, text)
  }
}

export const getIssue = (repo, number) => github(`/repos/${repo}/issues/${number}`)

export const addLabels = (repo, number, labels) =>
  github(`/repos/${repo}/issues/${number}/labels`, { method: "POST", body: { labels } })

export async function removeLabel(repo, number, label) {
  try {
    await github(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" })
  } catch (error) {
    if (error.status !== 404) throw error // the label was not on the issue
  }
}

export const comment = (repo, number, body) =>
  github(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body: `${body}

${FACTORY_MARK}` } })

// Opens a pull request, or updates the open one for the same branch, so a
// retried run never opens a second one.
export async function openPullRequest(repo, { head, base, title, body }) {
  const owner = repo.split("/")[0]
  const existing = await github(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`)
  if (existing.length > 0) {
    return github(`/repos/${repo}/pulls/${existing[0].number}`, { method: "PATCH", body: { title, body } })
  }
  return github(`/repos/${repo}/pulls`, { method: "POST", body: { head, base, title, body } })
}

// Every comment on the issue, oldest first, up to the first 100.
export const listComments = async (repo, number) =>
  (await github(`/repos/${repo}/issues/${number}/comments?per_page=100`)).map((c) => ({ author: c.user?.login, body: c.body ?? "" }))

// Comments written by people, oldest first. A user who answers the agent's
// question in a comment is heard this way.
export async function getHumanComments(repo, number) {
  return (await listComments(repo, number)).filter((c) => !c.body.includes(FACTORY_MARK))
}

// State of a factory workflow run, or null when the token may not read it.
export async function getWorkflowRun(repo, runId, token) {
  try {
    return await github(`/repos/${repo}/actions/runs/${runId}`, { token })
  } catch (error) {
    if (error.status === 403 || error.status === 404) return null
    throw error
  }
}
