// Proves the git behaviour run.mjs relies on when it pushes the factory branch:
// a lease taken from ls-remote, with an explicit URL and no remote-tracking ref.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { factoryCommitMessage, isFactoryCommit } from "../src/guards.mjs"

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" })
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lease-"))
  const remote = join(root, "remote.git")
  git(root, "init", "--quiet", "--bare", remote)
  const seed = join(root, "seed")
  git(root, "init", "--quiet", seed)
  git(seed, "commit", "--quiet", "--allow-empty", "-m", "base")
  git(seed, "push", "--quiet", remote, "HEAD:refs/heads/main")
  const work = join(root, "work")
  git(root, "clone", "--quiet", remote, work)
  git(work, "checkout", "--quiet", "-b", "factory/issue-1")
  return { root, remote, work }
}

const lease = (sha) => `--force-with-lease=refs/heads/factory/issue-1:${sha}`
const remoteSha = (work, remote) => /^([0-9a-f]{40})\s/m.exec(git(work, "ls-remote", remote, "refs/heads/factory/issue-1").out)?.[1] ?? ""

test("first push: an empty lease succeeds while the branch does not exist", () => {
  const { remote, work } = fixture()
  assert.equal(remoteSha(work, remote), "")
  git(work, "commit", "--quiet", "--allow-empty", "-m", factoryCommitMessage("t", 1, "r1"))
  assert.ok(git(work, "push", "--quiet", lease(""), remote, "factory/issue-1:refs/heads/factory/issue-1").ok)
})

test("a branch that appeared after inspection is not overwritten", () => {
  const { root, remote, work } = fixture()
  const seen = remoteSha(work, remote) // "" - not there yet
  // Someone else pushes the branch meanwhile.
  const other = join(root, "other")
  git(root, "clone", "--quiet", remote, other)
  git(other, "commit", "--quiet", "--allow-empty", "-m", "a person's work")
  git(other, "push", "--quiet", remote, "HEAD:refs/heads/factory/issue-1")

  git(work, "commit", "--quiet", "--allow-empty", "-m", factoryCommitMessage("t", 1, "r2"))
  const push = git(work, "push", "--quiet", lease(seen), remote, "factory/issue-1:refs/heads/factory/issue-1")
  assert.equal(push.ok, false)
  assert.match(push.out, /stale info|rejected/)
})

test("a factory branch is replaced when the lease matches, and a person's head is recognised", () => {
  const { root, remote, work } = fixture()
  const other = join(root, "other")
  git(root, "clone", "--quiet", remote, other)
  git(other, "checkout", "--quiet", "-b", "factory/issue-1")
  git(other, "commit", "--quiet", "--allow-empty", "-m", factoryCommitMessage("old", 1, "r0"))
  git(other, "push", "--quiet", remote, "factory/issue-1:refs/heads/factory/issue-1")

  const seen = remoteSha(work, remote)
  assert.match(seen, /^[0-9a-f]{40}$/)
  assert.ok(git(work, "fetch", "--quiet", "--depth", "1", remote, "refs/heads/factory/issue-1").ok)
  assert.ok(isFactoryCommit(git(work, "log", "-1", "--format=%B", "FETCH_HEAD").out))

  git(work, "commit", "--quiet", "--allow-empty", "-m", factoryCommitMessage("new", 1, "r3"))
  assert.ok(git(work, "push", "--quiet", lease(seen), remote, "factory/issue-1:refs/heads/factory/issue-1").ok)

  git(other, "commit", "--quiet", "--allow-empty", "-m", "hand-made fix")
  git(other, "push", "--quiet", "--force", remote, "factory/issue-1:refs/heads/factory/issue-1")
  git(work, "fetch", "--quiet", "--depth", "1", remote, "refs/heads/factory/issue-1")
  assert.equal(isFactoryCommit(git(work, "log", "-1", "--format=%B", "FETCH_HEAD").out), false)
})
