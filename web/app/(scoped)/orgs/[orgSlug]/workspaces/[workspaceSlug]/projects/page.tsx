import { Suspense } from "react"
import { notFound } from "next/navigation"
import { getWorkspaceScope } from "@/data/workspaces"
import { listAllAgentsCachedQuery } from "@/data/agent.queries"
import {
  getChatSessionPreference,
  getCodingProject,
  listCodingProjects,
} from "@/lib/gateway/client"
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
  const client = getGatewayServerClient(scope.workspace.id)
  const [projects, agents, detail, preference] = await Promise.all([
    listCodingProjects({ client }),
    listAllAgentsCachedQuery(scope.workspace.id),
    search.project ? getCodingProject({ client, path: { projectId: search.project } }) : undefined,
    getChatSessionPreference({ client }),
  ])
  if (detail?.response?.status === 404) notFound()
  if (detail?.error) throw new Error("Could not load project", { cause: detail.error })
  if (projects.error || agents.error || preference.error) throw new Error("Could not load projects")
  const usableAgents = agents.agents.filter((agent) => agent.capabilities.use)
  const selected =
    usableAgents.find((agent) => agent.name === search.agent) ??
    usableAgents.find((agent) => agent.name === preference.data.last_agent_name) ??
    usableAgents[0]
  return (
    <Projects
      projects={projects.data}
      detail={detail?.data}
      agentNames={usableAgents.map((agent) => agent.name)}
      agentName={selected?.name ?? ""}
      chatPreferences={preference.data}
      workspaceId={scope.workspace.id}
      workspacePath={`/orgs/${orgSlug}/workspaces/${workspaceSlug}`}
    />
  )
}
