import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getWorkspaceScope } from "@/data/workspaces"
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import { getCodingProject, listCodingProjects } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { Projects } from "@/components/blocks/coding/projects"

export const metadata = { title: "Projects" }

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ project?: string }>
}

export default function ProjectsPage(props: Props) {
  return <Suspense fallback={null}><ProjectsContent {...props} /></Suspense>
}

async function ProjectsContent({ params, searchParams }: Props) {
  const [{ orgSlug, workspaceSlug }, search] = await Promise.all([params, searchParams])
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready" || scope.workspace.type !== "coding") notFound()
  const client = getGatewayServerClient(scope.workspace.id)
  const [projects, agents, detail] = await Promise.all([
    listCodingProjects({ client }), listAllAgentsCachedQuery(scope.workspace.id),
    search.project ? getCodingProject({ client, path: { projectId: search.project } }) : undefined,
  ])
  if (detail?.error) notFound()
  if (projects.error || agents.error) throw new Error("Could not load projects")
  return <Projects projects={projects.data} detail={detail?.data}
    agentNames={agents.agents.filter((agent) => agent.capabilities.use).map((agent) => agent.name)}
    workspaceId={scope.workspace.id} workspacePath={`/orgs/${orgSlug}/workspaces/${workspaceSlug}`} />
}
