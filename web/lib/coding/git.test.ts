import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { withTrustedRepository } from "./git"

const execute = promisify(execFile)

test("trusted Git imports objects and creates only the reviewed commit under the acting identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentz-git-test-"))
  try {
    const run = async (...args: string[]) => {
      const { stdout } = await execute("git", args, {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          HOME: directory,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Original author",
          GIT_AUTHOR_EMAIL: "original@example.com",
          GIT_COMMITTER_NAME: "Original author",
          GIT_COMMITTER_EMAIL: "original@example.com",
        },
      })
      return stdout.trim()
    }
    await run("init", "-b", "main")
    await writeFile(join(directory, "README.md"), "before\n")
    await run("add", ".")
    await run("commit", "-m", "Original commit")
    const head = await run("rev-parse", "HEAD")
    await writeFile(join(directory, "README.md"), "after\n")
    await run("add", ".")
    const tree = await run("write-tree")
    const transport = await run("commit-tree", tree, "-p", head, "-m", "Transport")
    await run("update-ref", "refs/agentz/export", transport)
    const marker = join(directory, "hook-ran")
    await writeFile(join(directory, "evil-hook"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
    await run("config", "core.hooksPath", directory)
    await run("config", "credential.helper", `!touch '${marker}'`)
    await run("config", "remote.origin.url", "https://attacker.invalid/repo")
    await run("bundle", "create", "input.bundle", "--branches", "refs/agentz/export")
    const input = (await readFile(join(directory, "input.bundle"))).toString("base64")
    const token = "ghu_test_credential_must_never_reach_a_bundle"
    await withTrustedRepository("example/repository", token, async (git) => {
      await git.importBundle(input)
      assert.equal(await git.run("config", "--get", "core.hooksPath"), "/dev/null")
      await assert.rejects(git.run("config", "--get", "remote.origin.url"))
      await assert.rejects(
        git.commit("0".repeat(40), head, "main", "Wrong tree", {
          name: "Acting user",
          email: "1+actor@users.noreply.github.com",
        })
      )
      const commit = await git.commit(tree, head, "main", "Reviewed change", {
        name: "Acting user",
        email: "1+actor@users.noreply.github.com",
      })
      assert.equal(
        await git.run("show", "-s", "--format=%an <%ae>", commit),
        "Acting user <1+actor@users.noreply.github.com>"
      )
      assert.equal(await git.run("rev-parse", `${commit}^`), head)
      assert.equal(await git.run("rev-parse", `${commit}^{tree}`), tree)
      assert.equal(await git.run("show", "-s", "--format=%an", head), "Original author")
      const output = Buffer.from(await git.exportBundle(), "base64")
      assert.equal(output.includes(Buffer.from(token)), false)
      await assert.rejects(access(marker))
    })
    await assert.rejects(
      withTrustedRepository("https://attacker.invalid/repo", token, async () => undefined)
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
