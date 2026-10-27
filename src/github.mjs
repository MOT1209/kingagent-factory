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

// Seconds a single request may take before it is given up on. A hung
// connection would otherwise hold the whole workflow until its own timeout.
export const REQUEST_TIMEOUT_MS = 30_000

// Anything that looks like a token is cut out of text before it can reach a
// log, an issue comment or a thrown message. GitHub does not echo the caller's
// token, but a proxy or an error page might.
const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
export const scrub = (text, token = process.env.FACTORY_GITHUB_TOKEN) => {
  let out = String(text ?? "").replace(TOKEN_SHAPE, "***")
  if (token && token.length >= 8) out = out.replaceAll(token, "***")
  return out
}

// A GitHub error with the status, and a sentence on what usually causes it.
export class GitHubError extends Error {
  constructor(method, path, status, text) {
    super(`GitHub ${method} ${path} failed: ${status} ${scrub(text).slice(0, 500)}\n${hintFor(status, text)}`)
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

// How long to wait before the next try: Retry-After (seconds or a date), then
// the rate-limit reset time, then exponential backoff. Jitter keeps runs that
// failed together from retrying together. Never more than a minute.
export function retryDelayMs(attempt, headers = new Map(), now = Date.now(), random = Math.random()) {
  const retryAfter = headers.get?.("retry-after")
  let wait = Number(retryAfter) * 1000
  if (!Number.isFinite(wait) && retryAfter) wait = Date.parse(retryAfter) - now
  if (!(wait > 0) && headers.get?.("x-ratelimit-remaining") === "0") wait = Number(headers.get?.("x-ratelimit-reset")) * 1000 - now
  if (!(wait > 0)) wait = 2000 * 2 ** (attempt - 1)
  return Math.min(Math.round(wait + random * 1000), 60_000)
}

// A 5xx or a dropped connection says nothing about whether GitHub applied the
// write. Repeating a GET, PUT, PATCH or DELETE is harmless; repeating a POST can
// post a comment or open a pull request twice. A rate limit (429 or a 403 that
// says so) is refused before GitHub does anything, so it is safe for every method.
// `idempotent` lets a caller vouch for a POST (adding labels is one).
const rejectedBeforeProcessing = (status) => status === 429 || status === 403
const safeToRepeat = (method, idempotent) => idempotent || method !== "POST"

// `token` overrides FACTORY_GITHUB_TOKEN, for the workflow's own GITHUB_TOKEN.
export async function github(path, { method = "GET", body, token = process.env.FACTORY_GITHUB_TOKEN, idempotent = false } = {}) {
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // A network failure. A request that never connected is always safe to
      // repeat. After a reset or a timeout the write may have landed, so only
      // calls that are harmless to repeat go again.
      const code = String(error.cause?.code ?? error.message)
      const neverSent = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)
      if (attempt < 3 && (neverSent || safeToRepeat(method, idempotent))) {
        await transport.sleep(retryDelayMs(attempt))
        continue
      }
      throw new Error(`GitHub ${method} ${path} could not be reached${neverSent || error.name !== "TimeoutError" ? "" : " (timed out)"}: ${scrub(error.message, token)}`)
    }
    if (response.ok) return response.status === 204 ? null : response.json()

    const text = await response.text()
    if (attempt < 3 && isTransient(response.status, text, response.headers) && (rejectedBeforeProcessing(response.status) || safeToRepeat(method, idempotent))) {
      await transport.sleep(retryDelayMs(attempt, response.headers))
      continue
    }
    throw new GitHubError(method, path, response.status, text)
  }
}

export const getIssue = (repo, number) => github(`/repos/${repo}/issues/${number}`)

export const addLabels = (repo, number, labels) =>
  github(`/repos/${repo}/issues/${number}/labels`, { method: "POST", body: { labels }, idempotent: true })

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
// retried run never opens a second one. An open pull request is only reused when
// it really is this repo's branch into the expected base: a request for another
// base, or from a fork's branch of the same name, is somebody else's work.
export async function openPullRequest(repo, { head, base, title, body }) {
  const owner = repo.split("/")[0]
  const findOpen = async () => {
    const open = await github(`/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(head)}`)
    return open.find((pr) => (pr.head?.repo?.full_name ?? repo).toLowerCase() === repo.toLowerCase() && (pr.head?.ref ?? head) === head)
  }
  const reuse = async (existing) => {
    if ((existing.base?.ref ?? base) !== base) {
      throw new Error(`Pull request #${existing.number} in ${repo} is open for branch ${head} but targets ${existing.base.ref}, not ${base}. It was left alone; close it and add the ready label again.`)
    }
    return github(`/repos/${repo}/pulls/${existing.number}`, { method: "PATCH", body: { title, body } })
  }
  const existing = await findOpen()
  if (existing) return reuse(existing)
  try {
    return await github(`/repos/${repo}/pulls`, { method: "POST", body: { head, base, title, body } })
  } catch (error) {
    // A 422 can mean a pull request for this branch appeared since the lookup
    // (a retried run, or a person). Take that one instead of failing.
    if (error.status === 422) {
      const raced = await findOpen()
      if (raced) return reuse(raced)
    }
    throw error
  }
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
