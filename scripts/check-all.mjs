// What `npm run check` runs: a syntax check of every source file, then the tests.
// It is a script rather than a shell one-liner so it works the same under cmd.exe.
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"

const root = new URL("../", import.meta.url)
const run = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const dir of ["src", "scripts"]) {
  for (const file of readdirSync(new URL(`${dir}/`, root)).filter((f) => f.endsWith(".mjs"))) run(["--check", `${dir}/${file}`])
}
run(["--test", ...readdirSync(new URL("test/", root)).filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`)])
