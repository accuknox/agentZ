import { AgentDialog } from "@/app/agent/agent-dialog"
import { AgentTable } from "@/app/agent-table"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { deleteAgentFormAction, type AgentActionScope } from "@/data/agent.actions"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export const unstable_instant = false

export const metadata = { title: "Agents" }

export default async function WorkspaceAgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    return <AdministrationState kind="forbidden" />
  }

  const pageToken = await searchParams.then((value) => value.page_token)
  const query = {
    limit: 50,
    page_token: Array.isArray(pageToken) ? pageToken[0] : pageToken,
  }
  const workspaceId = scope.workspace.id
  const agents = await listAgentsCachedQuery(query, workspaceId)
  if (agents.error) {
    if (agents.error.code === "forbidden") return <AdministrationState kind="forbidden" />

    return (
      <AdministrationState
        description={agents.error.message}
        kind="failed"
        title="Unable to load Agents"
      />
    )
  }
  const canAccessAgents = scope.workspace.capabilities.agents.author || agents.agents.length > 0
  if (!canAccessAgents) return <AdministrationState kind="forbidden" />

  const authorResources = scope.workspace.capabilities.agents.author
    ? await Promise.all([
        listSandboxesCachedQuery({ limit: 50 }, workspaceId),
        listImmutableSkillsCachedQuery(workspaceId),
      ])
    : undefined
  const sandboxes = authorResources?.[0]
  const skills = authorResources?.[1]
  if (sandboxes?.error || skills?.error) {
    const error = sandboxes?.error ?? skills?.error
    return (
      <AdministrationState
        description={error?.message}
        kind={error?.code === "forbidden" ? "forbidden" : "failed"}
        title={error?.code === "forbidden" ? undefined : "Unable to load Agent resources"}
      />
    )
  }

  const workspacePath: AgentActionScope["workspacePath"] = `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`
  const actionScope: AgentActionScope = { workspaceId, workspacePath }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          scope.workspace.capabilities.agents.author ? (
            <AgentDialog
              mode="create"
              actionScope={actionScope}
              immutableSkills={skills?.skills ?? []}
              sandboxes={sandboxes?.sandboxes ?? []}
              initialHasNextSandboxPage={sandboxes?.hasNextPage ?? false}
              initialNextSandboxPageToken={sandboxes?.nextPageToken ?? ""}
            />
          ) : null
        }
        title="Agents"
      />
      <AgentTable
        actionScope={actionScope}
        agents={agents.agents}
        immutableSkills={skills?.skills ?? []}
        sandboxes={sandboxes?.sandboxes ?? []}
        hasNextPage={agents.hasNextPage}
        initialHasNextSandboxPage={sandboxes?.hasNextPage ?? false}
        initialNextSandboxPageToken={sandboxes?.nextPageToken ?? ""}
        nextPageToken={agents.nextPageToken}
        deleteAgentAction={deleteAgentFormAction.bind(null, actionScope)}
      />
    </div>
  )
}
