import { RememberRoute, missingRoute } from "@/data/route-memory"
import { randomInt } from "node:crypto"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { Projects, ProjectPicker } from "@/components/blocks/coding/projects"
import { CodingChat } from "@/components/blocks/coding/chat"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import { getWorkspaceScope } from "@/data/workspaces"
import { getAuth } from "@/lib/auth"
import {
  getCodingProject,
  listCodingProjects,
  getChatSessionPreference,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { AgentUnavailable, RequestError } from "@/components/request-error"

export const metadata: Metadata = {
  title: { absolute: "New chat | AgentZ" },
}

export default async function NewChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ agent?: string; draft?: string; project?: string }>
}) {
  const [{ orgSlug, workspaceSlug }, query, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind === "error")
    return <RequestError title="Could not load this workspace" error={scope.error} />
  if (scope.kind !== "ready") return missingRoute()

  const [agentsResult, preference, authSession] = await Promise.all([
    listAllAgentsCachedQuery(scope.workspace.id),
    getChatSessionPreference({ client: getGatewayServerClient(scope.workspace.id) }),
    getAuth().api.getSession({ headers: requestHeaders }),
  ])
  if (agentsResult.error || preference.error) {
    return (
      <RequestError
        title="Could not prepare a new conversation"
        error={agentsResult.error ?? preference.error}
      />
    )
  }
  const agents = agentsResult.agents.filter((agent) => agent.capabilities.use)
  const selected =
    agents.find((agent) => agent.name === query.agent) ??
    agents.find((agent) => agent.name === preference.data.last_agent_name) ??
    agents[0]
  if (!selected) {
    return (
      <main className="grid h-full flex-1 place-items-center px-6">
        <RememberRoute />
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold">No agent is ready for chat</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create an agent or ask a workspace administrator for access.
          </p>
        </div>
      </main>
    )
  }
  if (selected.status === "DEGRADED") return <AgentUnavailable agent={selected} />
  const firstName =
    authSession?.user.name?.trim().split(/\s+/, 1)[0] ||
    authSession?.user.email.split("@")[0]?.trim() ||
    undefined
  const workspacePath =
    `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}` as const

  if (scope.workspace.type === "coding") {
    if (!query.project) {
      const projects = await listCodingProjects({
        client: getGatewayServerClient(scope.workspace.id),
      })
      if (projects.error)
        return <RequestError title="Could not load projects" error={projects.error} />
      if (projects.data.length === 1 && projects.data[0]) {
        const next = new URLSearchParams({ project: projects.data[0].id })
        if (query.agent) next.set("agent", query.agent)
        redirect(`${workspacePath}/sessions/new?${next}`)
      }
      if (projects.data.length === 0)
        return (
          <>
            <RememberRoute />
            <Projects
              projects={[]}
              agentNames={agents.map((agent) => agent.name)}
              workspaceId={scope.workspace.id}
              workspacePath={workspacePath}
            />
          </>
        )
      return (
        <>
          <RememberRoute />
          <ProjectPicker projects={projects.data} workspacePath={workspacePath} />
        </>
      )
    }
    const project = await getCodingProject({
      client: getGatewayServerClient(scope.workspace.id),
      path: { projectId: query.project },
    })
    if (project.response?.status === 404) return missingRoute()
    if (project.error)
      return <RequestError title="Could not load this project" error={project.error} />
    return (
      <>
        <RememberRoute />
        <CodingChat
          key={project.data.project.id}
          project={project.data.project}
          greetingIndex={randomInt(5)}
          agentNames={agents.map((agent) => agent.name)}
          chatPreferences={preference.data}
          workspaceId={scope.workspace.id}
          workspacePath={workspacePath}
        />
      </>
    )
  }
  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <RememberRoute />
      <ChatShell
        agentName={selected.name}
        agentNames={agents.map((agent) => agent.name)}
        chatPreferences={preference.data}
        firstName={firstName}
        greetingIndex={randomInt(10)}
        title="New chat"
        workspaceId={scope.workspace.id}
        workspacePath={workspacePath}
      />
    </main>
  )
}
