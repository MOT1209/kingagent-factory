// The runner-side git module against local bare repos.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as host from "../src/git-host.mjs"

const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" })

function remoteWithBase() {
  const root = mkdtempSync(join(tmpdir(), "githost-"))
  git(root, "init", "--quiet", "--bare", join(root, "o", "r.git"))
  const seed = join(root, "seed")
  git(root, "init", "--quiet", seed)
  writeFileSync(join(seed, "a.txt"), "a\n")
  git(seed, "add", "-A")
  git(seed, "commit", "--quiet", "-m", "base")
  git(seed, "push", "--quiet", join(root, "o", "r.git"), "HEAD:refs/heads/main")
  host.hosting.base = `file://${root}/`
  return root
}

test("clone, apply a patch, commit and push a new branch", () => {
  const root = remoteWithBase()
  const { dir, baseSha } = host.cloneBase("o/r", "main", "tok")
  assert.match(baseSha, /^[0-9a-f]{40}$/)
  assert.deepEqual(host.inspectBranch(dir, "o/r", "factory/issue-1", "tok"), { remoteSha: "", humanCommit: false })

  const patch = Buffer.from("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n a\n+b\n")
  assert.deepEqual(host.applyPatch(dir, patch), ["a.txt"])
  host.commit(dir, { branch: "factory/issue-1", author: { name: "F", email: "f@e" }, message: "t\n\nFactory-Run: 1" })
  host.push(dir, "o/r", "factory/issue-1", "", "tok")
  assert.equal(git(root, "--git-dir", join(root, "o", "r.git"), "show", "factory/issue-1:a.txt").stdout, "a\nb\n")
  assert.equal(host.inspectBranch(dir, "o/r", "factory/issue-1", "tok").humanCommit, false)
  host.cleanup(dir)
  assert.equal(existsSync(dir), false)
})

test("an empty patch stages nothing", () => {
  remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main")
  assert.deepEqual(host.applyPatch(dir, Buffer.alloc(0)), [])
})

test("a patch that reaches outside the repo is refused", () => {
  const root = remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main")
  const evil = Buffer.from("diff --git a/../escape.txt b/../escape.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+pwned\n")
  assert.throws(() => host.applyPatch(dir, evil), /git apply failed/)
  assert.equal(existsSync(join(dir, "..", "escape.txt")), false)
  assert.equal(existsSync(join(root, "escape.txt")), false)
})

test("the clone keeps no token in its config", () => {
  remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main", "ghp_secret_value")
  assert.doesNotMatch(git(dir, "config", "--list", "--local").stdout, /ghp_secret_value/)
})

test("git and tar see a short list of variables, never the factory's secrets", () => {
  const env = host.cleanEnv({ PATH: "/bin", HTTPS_PROXY: "http://p", UPSTASH_BOX_API_KEY: "k", FACTORY_SECRETS_JSON: "{}", FACTORY_GITHUB_TOKEN: "t", GIT_SSH_COMMAND: "evil", GIT_DIR: "/x", GIT_EXEC_PATH: "/y", LD_PRELOAD: "/z" })
  assert.deepEqual(Object.keys(env).sort(), ["HTTPS_PROXY", "PATH"])
})

test("a failing git command never echoes the token", () => {
  remoteWithBase()
  const token = "ghp_super_secret_value_12345"
  host.hosting.base = "file:///definitely/not/here/"
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64")
  try {
    host.cloneBase("o/r", "main", token)
    assert.fail("expected a failure")
  } catch (error) {
    assert.doesNotMatch(error.message, new RegExp(`${token}|${basic}`))
  }
})

test("the process environment cannot redirect the trusted git", () => {
  const root = remoteWithBase()
  process.env.GIT_DIR = join(root, "nonexistent")
  process.env.GIT_SSH_COMMAND = "touch " + join(root, "pwned")
  try {
    const { dir } = host.cloneBase("o/r", "main")
    assert.ok(existsSync(join(dir, "a.txt")))
    assert.equal(existsSync(join(root, "pwned")), false)
  } finally {
    delete process.env.GIT_DIR
    delete process.env.GIT_SSH_COMMAND
  }
})

test("a patch cannot write into .git/ (hooks) of the trusted clone", () => {
  remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main")
  const evil = Buffer.from("diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+touch /tmp/x\n")
  assert.throws(() => host.applyPatch(dir, evil), /git apply failed/)
  assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), false)
})

test("a hook in the clone does not run during the trusted commit", () => {
  const root = remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main")
  const marker = join(root, "hook-ran")
  writeFileSync(join(dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  writeFileSync(join(dir, "n.txt"), "n\n")
  git(dir, "add", "-A")
  host.commit(dir, { branch: "factory/issue-2", author: { name: "F", email: "f@e" }, message: "t\n\nFactory-Run: 2" })
  assert.equal(existsSync(marker), false)
})

test("a push loses to a branch that moved after it was inspected", () => {
  const root = remoteWithBase()
  const { dir } = host.cloneBase("o/r", "main")
  const seen = host.inspectBranch(dir, "o/r", "factory/issue-3", "")
  // A person pushes to the branch between inspect and push.
  const other = join(root, "person")
  git(root, "clone", "--quiet", join(root, "o", "r.git"), other)
  writeFileSync(join(other, "p.txt"), "human\n")
  git(other, "add", "-A")
  git(other, "commit", "--quiet", "-m", "human work")
  git(other, "push", "--quiet", "origin", "HEAD:refs/heads/factory/issue-3")
  writeFileSync(join(dir, "f.txt"), "f\n")
  git(dir, "add", "-A")
  host.commit(dir, { branch: "factory/issue-3", author: { name: "F", email: "f@e" }, message: "t\n\nFactory-Run: 3" })
  assert.throws(() => host.push(dir, "o/r", "factory/issue-3", seen.remoteSha, ""), /git push failed/)
  assert.equal(git(root, "--git-dir", join(root, "o", "r.git"), "log", "-1", "--format=%s", "factory/issue-3").stdout.trim(), "human work")
})
