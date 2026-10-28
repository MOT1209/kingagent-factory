// Git work that needs the GitHub token, done on the machine running the
// factory (the Actions runner), never inside the Box.
//
// The Box user has passwordless sudo and the Box keeps its disk between jobs,
// so an agent could replace git there or leave a process behind. Anything the
// token touches inside the Box could leak. So the runner clones, hands the Box
// a tarball, takes back a patch, applies it, commits and pushes. The checks on
// what gets pushed (protected paths, the branch owner) run here too, where the
// agent cannot change them.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isFactoryCommit } from "./guards.mjs"

// Where repos live. Tests point this at local bare repos.
export const hosting = { base: "https://github.com/" }
export const remoteUrl = (repo) => `${hosting.base}${repo}.git`

// The token goes to git as an HTTP header in the environment, the way
// actions/checkout does it: never in a URL, never in .git/config, and only for
// github.com. A fresh, empty global config keeps the user's own settings
// (credential helpers, url rewrites) out of it.
//
// Git also starts from a short list of the runner's variables, not all of them:
// the Box key, the Actions secrets blob and every GIT_* override (GIT_DIR,
// GIT_SSH_COMMAND, GIT_EXEC_PATH...) stay out of every git and tar process. The
// proxy and CA variables are kept, since some runners cannot reach GitHub without.
const PASS_THROUGH = /^(PATH|LANG|LC_[A-Z]+|TMPDIR|TMP|TEMP|SYSTEMROOT|COMSPEC|PATHEXT|(HTTPS?|NO|ALL)_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|GIT_SSL_CAINFO)$/i
export function cleanEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => PASS_THROUGH.test(key)))
}

function gitEnv(token) {
  const env = { ...cleanEnv(), HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` })
  }
  return env
}

function git(dir, args, { token, allowFailure = false, input } = {}) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: gitEnv(token), encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (result.status !== 0 && !allowFailure) {
    // The token (and its base64 header form) never goes into a message, even if git echoes a header.
    const hidden = token ? [token, Buffer.from(`x-access-token:${token}`).toString("base64")] : []
    const safe = hidden.reduce((text, secret) => text.replaceAll(secret, "***"), output)
    throw new Error(`git ${args[0]} failed (exit ${result.status}):\n${safe.slice(-2000)}`)
  }
  return { code: result.status, output, stdout: (result.stdout ?? "").trim() }
}

// A shallow clone of the base branch in a new temp folder.
export function cloneBase(repo, baseBranch, token) {
  const dir = mkdtempSync(join(tmpdir(), "factory-repo-"))
  git(tmpdir(), ["clone", "--quiet", "--depth", "50", "--single-branch", "--branch", baseBranch, remoteUrl(repo), dir], { token })
  return { dir, baseSha: git(dir, ["rev-parse", "HEAD"]).stdout }
}

// The branch is replaced by each run, so it may only hold factory commits. A
// head without the factory trailer means a person pushed there. The SHA seen
// here is the lease for the later push.
export function inspectBranch(dir, repo, branch, token) {
  const listed = git(dir, ["ls-remote", remoteUrl(repo), `refs/heads/${branch}`], { token }).stdout
  const remoteSha = /^([0-9a-f]{40})\s/m.exec(listed)?.[1] ?? ""
  if (!remoteSha) return { remoteSha: "", humanCommit: false }
  git(dir, ["fetch", "--quiet", "--depth", "1", remoteUrl(repo), `refs/heads/${branch}`], { token })
  return { remoteSha, humanCommit: !isFactoryCommit(git(dir, ["log", "-1", "--format=%B", "FETCH_HEAD"]).stdout) }
}

// The clone as a gzipped tarball, for the Box. It goes through stdout, not a
// file: GNU tar reads a Windows path like C:\... after -f as host:path.
export function packRepo(dir) {
  return execFileSync("tar", ["-czf", "-", "-C", dir, "."], { env: cleanEnv(), maxBuffer: 1024 * 1024 * 1024 })
}

// Applies the Box's patch to the clone and stages it. Returns the staged files.
export function applyPatch(dir, patch) {
  if (!patch.length) return []
  const folder = mkdtempSync(join(tmpdir(), "factory-patch-"))
  try {
    const file = join(folder, "change.patch")
    writeFileSync(file, patch)
    git(dir, ["apply", "--index", "--binary", "--whitespace=nowarn", file])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  // --no-renames lists both sides of a rename, so moving a file out of a
  // protected folder still names the protected path.
  return git(dir, ["diff", "--cached", "--name-only", "--no-renames", "-z"]).stdout.split("\0").filter(Boolean)
}

export function commit(dir, { branch, author, message }) {
  git(dir, ["checkout", "--quiet", "-B", branch])
  git(dir, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "--no-verify", "-F", "-"], { input: message })
  return git(dir, ["rev-parse", "HEAD"]).stdout
}

// The lease fails the push if the branch moved since inspectBranch. An empty
// lease means "the branch must not exist yet".
export function push(dir, repo, branch, remoteSha, token) {
  git(dir, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${remoteSha}`, remoteUrl(repo), `HEAD:refs/heads/${branch}`], { token })
}

export const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })
