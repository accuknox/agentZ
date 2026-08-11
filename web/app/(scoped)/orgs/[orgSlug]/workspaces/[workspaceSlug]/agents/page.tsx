import type { Route } from "next"
import { AgentDialog } from "@/app/agent/agent-dialog"
import { AgentTable } from "@/app/agent-table"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { deleteAgentFormAction, type AgentActionScope } from "@/data/agent.actions"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { listImmutableSkillsCachedQuery } from "@/data/skill.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export const unstable_instant = false

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
    return <ErrorPanel message="Workspace is unavailable" />
  }

  const pageToken = await searchParams.then((value) => value.page_token)
  const query = {
    limit: 50,
    page_token: Array.isArray(pageToken) ? pageToken[0] : pageToken,
  }
  const workspaceId = scope.workspace.id
  const [agents, sandboxes, skills] = await Promise.all([
    listAgentsCachedQuery(query, workspaceId),
    listSandboxesCachedQuery({ limit: 50 }, workspaceId),
    listImmutableSkillsCachedQuery(workspaceId),
  ])
  if (agents.error) {
    return <ErrorPanel message={agents.error.message} />
  }
  if (sandboxes.error) {
    return <ErrorPanel message={sandboxes.error.message} />
  }
  if (skills.error) {
    return <ErrorPanel message={skills.error.message} />
  }

  const basePath =
    `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents` as Route
  const actionScope: AgentActionScope = { basePath, workspaceId }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AdministrationPageHeader
        actions={
          <AgentDialog
            mode="create"
            actionScope={actionScope}
            immutableSkills={skills.skills}
            sandboxes={sandboxes.sandboxes}
            initialHasNextSandboxPage={sandboxes.hasNextPage}
            initialNextSandboxPageToken={sandboxes.nextPageToken}
          />
        }
        title="Agents"
      />
      <AgentTable
        actionScope={actionScope}
        agents={agents.agents}
        immutableSkills={skills.skills}
        sandboxes={sandboxes.sandboxes}
        hasNextPage={agents.hasNextPage}
        initialHasNextSandboxPage={sandboxes.hasNextPage}
        initialNextSandboxPageToken={sandboxes.nextPageToken}
        nextPageToken={agents.nextPageToken}
        deleteAgentAction={deleteAgentFormAction.bind(null, actionScope)}
      />
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Unable to load agents</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
