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
