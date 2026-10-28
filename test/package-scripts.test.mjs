// npm runs scripts through cmd.exe on Windows, so `check` must not need a POSIX shell.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("npm run check uses no POSIX shell syntax", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.doesNotMatch(scripts.check, /\bfor\b|\bdo\b|\bdone\b|\$\(|\|\||\bexit\b/)
})
