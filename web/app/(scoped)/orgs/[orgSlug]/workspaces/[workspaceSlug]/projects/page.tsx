import { Suspense } from "react"
import { notFound, redirect } from "next/navigation"
import { getWorkspaceScope } from "@/data/workspaces"
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import { listCodingProjects } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { AdministrationLoadingState } from "@/components/administration"
import { Projects } from "@/components/blocks/coding/projects"

export const metadata = { title: "Projects" }

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ project?: string; agent?: string }>
}

export default function ProjectsPage(props: Props) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <ProjectsContent {...props} />
    </Suspense>
  )
}

async function ProjectsContent({ params, searchParams }: Props) {
  const [{ orgSlug, workspaceSlug }, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type !== "coding") notFound()
  if (search.project)
    redirect(
      `/orgs/${orgSlug}/workspaces/${workspaceSlug}/sessions/new?${new URLSearchParams({ project: search.project, ...(search.agent ? { agent: search.agent } : {}) })}`
    )
  const client = getGatewayServerClient(scope.workspace.id)
  const [projects, agents] = await Promise.all([
    listCodingProjects({ client }),
    listAllAgentsCachedQuery(scope.workspace.id),
  ])
  if (projects.error || agents.error) throw new Error("Could not load projects")
  const usableAgents = agents.agents.filter((agent) => agent.capabilities.use)
  return (
    <Projects
      projects={projects.data}
      agentNames={usableAgents.map((agent) => agent.name)}
      workspaceId={scope.workspace.id}
      workspacePath={`/orgs/${orgSlug}/workspaces/${workspaceSlug}`}
      pageScope={{
        kind: "workspace",
        organizationName: scope.scope.organization.name,
        workspaceName: scope.workspace.name,
      }}
    />
  )
}
