import "server-only"

import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

// Each request uses an owned bare repository. No agent configuration, hooks,
// worktree, environment or executable crosses this boundary. Only Git objects do.
export async function withTrustedRepository<T>(
  repository: string,
  token: string,
  action: (git: {
    run: (...args: string[]) => Promise<string>
    remote: (command: "fetch" | "push" | "ls-remote", ...args: string[]) => Promise<string>
    importBundle: (bundle: string) => Promise<void>
    exportBundle: () => Promise<string>
    commit: (
      tree: string,
      head: string,
      branch: string,
      message: string,
      identity: { name: string; email: string }
    ) => Promise<string>
  }) => Promise<T>
): Promise<T> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid GitHub repository")
  const directory = await mkdtemp(join(tmpdir(), "agentz-git-"))
  const gitDirectory = join(directory, "repository.git")
  const bundlePath = join(directory, "transfer.bundle")
  const url = `https://github.com/${repository}.git`
  const environment = {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  }
  const options = [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=always",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "transfer.fsckObjects=true",
  ]
  const run = async (...args: string[]) => {
    try {
      const { stdout } = await execute("git", [...options, ...args], {
        cwd: gitDirectory,
        env: environment,
        timeout: 120_000,
        maxBuffer: 64 << 20,
      })
      return stdout.trimEnd()
    } catch {
      throw new Error("Git operation failed. Refresh the checkout and retry.")
    }
  }
  const remote = async (command: "fetch" | "push" | "ls-remote", ...args: string[]) => {
    try {
      // Credentials exist only in this trusted child's environment, never in
      // argv, Git config, the bundle, or any agent process.
      const { stdout } = await execute(
        "git",
        [
          ...options,
          "-c",
          "protocol.https.allow=always",
          "-c",
          "http.followRedirects=false",
          command,
          url,
          ...args,
        ],
        {
          cwd: gitDirectory,
          timeout: 120_000,
          maxBuffer: 64 << 20,
          env: {
            ...environment,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          },
        }
      )
      return stdout.trimEnd()
    } catch {
      // execFile errors include env/arguments and remote diagnostics. Do not
      // propagate or log them across the credential boundary.
      throw new Error("GitHub Git request failed. Check access and refresh remote branches.")
    }
  }
  try {
    await execute("git", ["init", "--bare", gitDirectory], { env: environment, timeout: 10_000 })
    return await action({
      run,
      remote,
      async importBundle(bundle) {
        if (bundle.length > 90 << 20) throw new Error("Repository transfer exceeds 64 MiB")
        await writeFile(bundlePath, Buffer.from(bundle, "base64"), { mode: 0o600 })
        await run("bundle", "verify", bundlePath)
        await run(
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          bundlePath,
          "+refs/heads/*:refs/heads/*",
          "+refs/agentz/export:refs/agentz/export"
        )
        await run("fsck", "--strict", "--no-reflogs")
      },
      async exportBundle() {
        await rm(bundlePath, { force: true })
        await run("bundle", "create", bundlePath, "--branches")
        if ((await stat(bundlePath)).size > 64 << 20)
          throw new Error("Repository transfer exceeds 64 MiB")
        return (await readFile(bundlePath)).toString("base64")
      },
      async commit(tree, head, branch, message, identity) {
        await run("check-ref-format", "--branch", branch)
        const exportedTree = await run("rev-parse", "refs/agentz/export^{tree}")
        const exportedParent = await run("rev-parse", "refs/agentz/export^")
        if (exportedTree !== tree || exportedParent !== head)
          throw new Error("Staged changes changed; review the diff again")
        if ((await run("rev-parse", `${head}^{tree}`)) === tree)
          throw new Error("No staged changes to commit")
        const { stdout } = await execute(
          "git",
          [...options, "commit-tree", tree, "-p", head, "-m", message],
          {
            cwd: gitDirectory,
            timeout: 30_000,
            maxBuffer: 1 << 20,
            env: {
              ...environment,
              GIT_AUTHOR_NAME: identity.name,
              GIT_AUTHOR_EMAIL: identity.email,
              GIT_COMMITTER_NAME: identity.name,
              GIT_COMMITTER_EMAIL: identity.email,
            },
          }
        )
        const commit = stdout.trim()
        await run("update-ref", `refs/heads/${branch}`, commit, head)
        return commit
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
