"use server"

import { z } from "zod"
import { RequestError } from "@octokit/request-error"
import { withGitHub } from "@/lib/coding/github"
import { withTrustedRepository } from "@/lib/coding/git"
import {
  createCodingProject,
  createCodingThread,
  getCodingProject,
  getCodingThread,
  runCodingGit,
  type CodingGitRequest,
  type CreateCodingThreadRequest,
} from "@/lib/gateway/client"
import { zCodingGitRequest, zCreateCodingThreadRequest } from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function githubRepositories() {
  return withGitHub(async ({ octokit }) => {
    const installations = await octokit.paginate(
      octokit.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 }
    )
    const repositories = await Promise.all(
      installations.map((installation) =>
        octokit.paginate(octokit.apps.listInstallationReposForAuthenticatedUser, {
          installation_id: installation.id,
          per_page: 100,
        })
      )
    )
    return repositories.flat().map((repository) => ({
      id: repository.id,
      name: repository.full_name,
      private: repository.private,
    }))
  })
}

export async function addCodingProject(workspaceId: string, name: string, repositoryId: number) {
  z.string().min(1).max(80).parse(name)
  z.number().int().positive().parse(repositoryId)
  return withGitHub(async ({ octokit }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: repositoryId,
    })
    const result = await createCodingProject({
      client: getGatewayServerClient(workspaceId),
      body: {
        name,
        repository_id: repository.id,
        repository: repository.full_name,
        default_branch: repository.default_branch,
      },
    })
    if (result.error) throw new Error(result.error.message)
    return result.data
  })
}

export async function startCodingThread(
  workspaceId: string,
  input: Omit<CreateCodingThreadRequest, "bundle">
) {
  const body = zCreateCodingThreadRequest.parse(input)
  const client = getGatewayServerClient(workspaceId)
  const project = await getCodingProject({ client, path: { projectId: body.project_id } })
  if (project.error) throw new Error(project.error.message)
  if (
    body.worktree_id ||
    project.data.worktrees.some((tree) => tree.agent_name === body.agent_name && tree.ready)
  ) {
    const result = await createCodingThread({ client, body })
    if (result.error) throw new Error(result.error.message)
    return result.data
  }
  return withGitHub(async ({ octokit, token }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: project.data.project.repository_id,
    })
    const bundle = await withTrustedRepository(repository.full_name, token, async (git) => {
      await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/heads/*")
      // V1 does not provision submodules or LFS. Fail before creating a checkout.
      const ref = `refs/heads/${body.base_branch ?? repository.default_branch}`
      await git.run("check-ref-format", ref)
      const files = (await git.run("ls-tree", "-r", "-z", ref)).split("\0").filter(Boolean)
      for (const file of files) {
        if (file.startsWith("160000 ")) throw new Error("Submodules are not supported yet")
        const separator = file.indexOf("\t")
        const path = file.slice(separator + 1)
        if (path === ".gitattributes" || path.endsWith("/.gitattributes")) {
          const attributes = await git.run("show", `${ref}:${path}`)
          if (/(?:^|\s)filter=lfs(?:\s|$)/m.test(attributes))
            throw new Error("Git LFS repositories are not supported yet")
        }
      }
      return git.exportBundle()
    })
    const result = await createCodingThread({ client, body: { ...body, bundle } })
    if (result.error) throw new Error(result.error.message)
    return result.data
  })
}

async function localCodingGit(workspaceId: string, worktreeId: string, input: CodingGitRequest) {
  const body = zCodingGitRequest.parse(input)
  const result = await runCodingGit({
    client: getGatewayServerClient(workspaceId),
    path: { worktreeId },
    body,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}

const remoteOperation = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("commit"),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    tree: z.string().regex(/^[a-f0-9]{40,64}$/),
    message: z.string().trim().min(1).max(20_000),
  }),
  z.object({
    operation: z.literal("push"),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    remoteHead: z.string().regex(/^([a-f0-9]{40,64})?$/),
  }),
  z.object({ operation: z.literal("pull"), head: z.string().regex(/^[a-f0-9]{40,64}$/) }),
])

export async function remoteCodingGit(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  input: z.infer<typeof remoteOperation>
) {
  const operation = remoteOperation.parse(input)
  const client = getGatewayServerClient(workspaceId)
  const thread = await getCodingThread({ client, path: { agentName, sessionId } })
  if (thread.error) throw new Error(thread.error.message)
  const worktreeId = thread.data.worktree.id
  const exported = await localCodingGit(workspaceId, worktreeId, {
    operation: "export",
    expected_head: operation.head,
  })
  if (!exported.bundle || !exported.branch) throw new Error("Select a branch before using GitHub")
  const bundle = exported.bundle
  return withGitHub(async ({ octokit, token, name, email }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    return withTrustedRepository(repository.full_name, token, async (git) => {
      await git.importBundle(bundle)
      await git.run("check-ref-format", "--branch", exported.branch)
      if (operation.operation === "commit") {
        if (operation.tree !== exported.tree)
          throw new Error("Staged changes changed; review the diff again")
        await git.commit(operation.tree, operation.head, exported.branch, operation.message, {
          name,
          email,
        })
        return localCodingGit(workspaceId, worktreeId, {
          operation: "apply_commit",
          expected_head: operation.head,
          expected_tree: operation.tree,
          ref: exported.branch,
          bundle: await git.exportBundle(),
        })
      }
      if (operation.operation === "push") {
        const branchHead = await git.run("rev-parse", `refs/heads/${exported.branch}`)
        if (branchHead !== operation.head) throw new Error("Branch changed; refresh before pushing")
        // An exact lease prevents a concurrently changed remote from being
        // overwritten. Also require ancestry: this UI never offers force push.
        await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/remotes/origin/*")
        const remoteHead = await git
          .run("rev-parse", "--verify", `refs/remotes/origin/${exported.branch}`)
          .catch(() => "")
        if (remoteHead !== operation.remoteHead)
          throw new Error("Remote branch changed; review before pushing")
        if (remoteHead) await git.run("merge-base", "--is-ancestor", remoteHead, operation.head)
        await git.remote(
          "push",
          `--force-with-lease=refs/heads/${exported.branch}:${remoteHead}`,
          `${operation.head}:refs/heads/${exported.branch}`
        )
        // Only confirmed remote refs may become origin tracking refs on the agent.
        const heads = await git.run("for-each-ref", "--format=%(refname)", "refs/heads/")
        for (const ref of heads.split("\n").filter(Boolean)) await git.run("update-ref", "-d", ref)
        await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/heads/*")
        return localCodingGit(workspaceId, worktreeId, {
          operation: "import",
          bundle: await git.exportBundle(),
        })
      }
      await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/heads/*")
      return localCodingGit(workspaceId, worktreeId, {
        operation: "import",
        expected_head: operation.head,
        ref: exported.branch,
        bundle: await git.exportBundle(),
      })
    })
  })
}

export async function codingGitHubInfo(workspaceId: string, agentName: string, sessionId: string) {
  const thread = await getCodingThread({
    client: getGatewayServerClient(workspaceId),
    path: { agentName, sessionId },
  })
  if (thread.error) throw new Error(thread.error.message)
  const status = await localCodingGit(workspaceId, thread.data.worktree.id, { operation: "status" })
  return withGitHub(async ({ octokit }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    const repo = { owner: repository.owner.login, repo: repository.name }
    const [pulls, issues, branch] = await Promise.all([
      octokit.paginate(octokit.pulls.list, { ...repo, per_page: 100 }),
      octokit.paginate(octokit.issues.listForRepo, { ...repo, per_page: 100 }),
      octokit.git
        .getRef({ ...repo, ref: `heads/${status.branch}` })
        .then((result) => result.data.object.sha)
        .catch((error: unknown) => {
          if (error instanceof RequestError && error.status === 404) return ""
          throw new Error("Could not read the remote branch")
        }),
    ])
    return {
      branchHead: branch,
      defaultBranch: repository.default_branch,
      pulls: pulls.map((pull) => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
      })),
      issues: issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url })),
    }
  })
}

export async function createCodingPullRequest(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  title: string,
  body: string,
  base: string
) {
  z.string().trim().min(1).max(256).parse(title)
  z.string().max(65_536).parse(body)
  const thread = await getCodingThread({
    client: getGatewayServerClient(workspaceId),
    path: { agentName, sessionId },
  })
  if (thread.error) throw new Error(thread.error.message)
  const status = await localCodingGit(workspaceId, thread.data.worktree.id, { operation: "status" })
  return withGitHub(async ({ octokit }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    const repo = { owner: repository.owner.login, repo: repository.name }
    const remote = await octokit.git.getRef({ ...repo, ref: `heads/${status.branch}` })
    if (remote.data.object.sha !== status.head)
      throw new Error("Push your current branch before opening a pull request")
    const existing = await octokit.pulls.list({
      ...repo,
      head: `${repository.owner.login}:${status.branch}`,
      base,
    })
    if (existing.data[0]) return existing.data[0].html_url
    const result = await octokit.pulls.create({ ...repo, head: status.branch, base, title, body })
    return result.data.html_url
  })
}
