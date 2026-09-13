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
  suggestCodingText,
  type CodingGitRequest,
  type CreateCodingThreadRequest,
} from "@/lib/gateway/client"
import {
  zCreateCodingProjectRequest,
  zCreateCodingThreadRequest,
} from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function githubRepositories(query: string, page = 1) {
  z.string().max(256).parse(query)
  z.number().int().positive().parse(page)
  return withGitHub(async ({ octokit }) => {
    if (query) {
      if (page > 20) throw new Error("Narrow your repository search")
      const { data } = await octokit.search.repos({
        q: `${query} in:name fork:true`,
        per_page: 50,
        page,
      })
      return {
        repositories: data.items.map((repository) => ({
          id: repository.id,
          name: repository.full_name,
          private: repository.private,
        })),
        nextPage: page * 50 < Math.min(data.total_count, 1000) ? page + 1 : null,
        limited: data.incomplete_results || data.total_count > 1000,
      }
    }
    const { data, headers } = await octokit.repos.listForAuthenticatedUser({
      sort: "updated",
      per_page: 50,
      page,
    })
    return {
      repositories: data.map((repository) => ({
        id: repository.id,
        name: repository.full_name,
        private: repository.private,
      })),
      nextPage: headers.link?.includes('rel="next"') ? page + 1 : null,
      limited: false,
    }
  })
}

export async function addCodingProject(workspaceId: string, name: string, repositoryId: number) {
  zCreateCodingProjectRequest.shape.name.parse(name)
  zCreateCodingProjectRequest.shape.repository_id.parse(repositoryId)
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
  const result = await runCodingGit({
    client: getGatewayServerClient(workspaceId),
    path: { worktreeId },
    body: input,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}

const remoteOperation = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("commit"),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    tree: z.string().regex(/^[a-f0-9]{40,64}$/),
    message: z.string().trim().max(20_000),
  }),
  z.object({
    operation: z.literal("push"),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    remoteHead: z.string().regex(/^([a-f0-9]{40,64})?$/),
  }),
  z.object({ operation: z.literal("fetch"), head: z.string().regex(/^[a-f0-9]{40,64}$/) }),
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
  if (operation.operation === "commit" && !operation.message) {
    const suggestion = await suggestCodingText({
      client,
      path: { agentName, sessionId },
      body: { purpose: "commit", expected_tree: operation.tree },
    })
    if (suggestion.error) throw new Error(suggestion.error.message)
    operation.message = suggestion.data.text
  }
  const exported = await localCodingGit(workspaceId, worktreeId, {
    operation:
      operation.operation === "commit" || operation.operation === "push" ? "export" : "status",
    expected_head: operation.head,
  })
  if (!exported.branch) throw new Error("Select a branch before using GitHub")
  return withGitHub(async ({ octokit, token, name, email }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    return withTrustedRepository(repository.full_name, token, async (git) => {
      if (operation.operation === "commit" || operation.operation === "push") {
        if (!exported.bundle) throw new Error("Could not export the checkout")
        await git.importBundle(exported.bundle)
      }
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
      }
      await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/heads/*")
      if (operation.operation === "pull")
        await git.run("rev-parse", "--verify", `refs/heads/${exported.branch}`)
      return localCodingGit(workspaceId, worktreeId, {
        operation: "import",
        expected_head: operation.operation === "pull" ? operation.head : undefined,
        ref: operation.operation === "pull" ? exported.branch : undefined,
        bundle: await git.exportBundle(),
      })
    })
  })
}

export async function codingRemoteHead(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  branch: string
) {
  z.string().min(1).max(1024).parse(branch)
  const thread = await getCodingThread({
    client: getGatewayServerClient(workspaceId),
    path: { agentName, sessionId },
  })
  if (thread.error) throw new Error(thread.error.message)
  return withGitHub(async ({ octokit }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    try {
      const { data } = await octokit.git.getRef({
        owner: repository.owner.login,
        repo: repository.name,
        ref: `heads/${branch}`,
      })
      return data.object.sha
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return ""
      throw error
    }
  })
}

export async function codingGitHubStatus(
  workspaceId: string,
  agentName: string,
  sessionId: string
) {
  const thread = await getCodingThread({
    client: getGatewayServerClient(workspaceId),
    path: { agentName, sessionId },
  })
  if (thread.error) throw new Error(thread.error.message)
  const status = await localCodingGit(workspaceId, thread.data.worktree.id, { operation: "status" })
  if (!status.branch) return null
  return withGitHub(async ({ octokit }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    const { data: pulls } = await octokit.pulls.list({
      owner: repository.owner.login,
      repo: repository.name,
      head: `${repository.owner.login}:${status.branch}`,
      state: "open",
      per_page: 1,
    })
    let remoteHead = ""
    try {
      const { data } = await octokit.git.getRef({
        owner: repository.owner.login,
        repo: repository.name,
        ref: `heads/${status.branch}`,
      })
      remoteHead = data.object.sha
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error
    }
    if (status.head && status.tree && remoteHead !== status.remote_head) {
      await remoteCodingGit(workspaceId, agentName, sessionId, {
        operation: "fetch",
        head: status.head,
      })
    }
    const pr = pulls[0]
    return pr ? { number: pr.number, url: pr.html_url } : null
  })
}

export async function createCodingPullRequest(
  workspaceId: string,
  agentName: string,
  sessionId: string,
  head: string
) {
  z.string()
    .regex(/^[a-f0-9]{40,64}$/)
    .parse(head)
  const client = getGatewayServerClient(workspaceId)
  const thread = await getCodingThread({ client, path: { agentName, sessionId } })
  if (thread.error) throw new Error(thread.error.message)
  const exported = await localCodingGit(workspaceId, thread.data.worktree.id, {
    operation: "export",
    expected_head: head,
  })
  if (exported.files.length) throw new Error("Commit local changes before creating a PR.")
  if (!exported.bundle || !exported.branch) throw new Error("Select a branch before creating a PR.")
  const bundle = exported.bundle
  return withGitHub(async ({ octokit, token }) => {
    const { data: repository } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: thread.data.repository_id,
    })
    const repo = { owner: repository.owner.login, repo: repository.name }
    if (exported.branch === repository.default_branch)
      throw new Error("Create a feature branch before opening a PR.")
    const filter = {
      ...repo,
      head: `${repo.owner}:${exported.branch}`,
      state: "open",
      per_page: 1,
    } as const
    const { data: existing } = await octokit.pulls.list(filter)
    if (existing[0]) return { number: existing[0].number, url: existing[0].html_url }
    const text = await withTrustedRepository(repository.full_name, token, async (git) => {
      await git.importBundle(bundle)
      await git.remote("fetch", "--no-tags", "+refs/heads/*:refs/remotes/origin/*")
      const remote = await git.run("rev-parse", `refs/remotes/origin/${exported.branch}`)
      if (remote !== head) throw new Error("Branch changed; push and refresh before creating a PR.")
      const base = `refs/remotes/origin/${repository.default_branch}`
      const patch = await git.run(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `${base}...${head}`,
        "--"
      )
      if (!patch) throw new Error("No changes against the default branch.")
      const commits = await git.run("log", "--format=%s", `${base}..${head}`, "--")
      return `Branch: ${exported.branch}\nBase: ${repository.default_branch}\nCommits:\n${commits.slice(0, 6000)}\nDiff:\n${patch.slice(0, 40000)}`
    })
    const suggestion = await suggestCodingText({
      client,
      path: { agentName, sessionId },
      body: { purpose: "pr", text },
    })
    if (suggestion.error) throw new Error(suggestion.error.message)
    const content = suggestion.data.pull_request
    if (!content) throw new Error("PR content was not generated. Try again.")
    const status = await localCodingGit(workspaceId, thread.data.worktree.id, {
      operation: "status",
      expected_head: head,
    })
    if (status.branch !== exported.branch || status.files.length)
      throw new Error("Checkout changed while generating the PR. Refresh and retry.")
    const { data: remote } = await octokit.git.getRef({ ...repo, ref: `heads/${exported.branch}` })
    if (remote.object.sha !== head)
      throw new Error("Remote branch changed while generating the PR.")
    try {
      const { data: pr } = await octokit.pulls.create({
        ...repo,
        ...content,
        head: exported.branch,
        base: repository.default_branch,
        draft: false,
      })
      return { number: pr.number, url: pr.html_url }
    } catch (error) {
      // A competing request or a lost response may have already created it.
      const { data: pulls } = await octokit.pulls.list(filter)
      if (pulls[0]) return { number: pulls[0].number, url: pulls[0].html_url }
      throw error
    }
  })
}
