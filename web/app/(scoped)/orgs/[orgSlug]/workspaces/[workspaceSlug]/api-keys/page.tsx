import { Suspense } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CreateAPIKeyButton } from "@/app/(account)/settings/api-keys/dialog"
import { APIKeysTable } from "@/app/(account)/settings/api-keys/table"
import { createAPIKeyFormAction, deleteAPIKeyFormAction } from "@/data/api-key.actions"
import { listAPIKeysCachedQuery } from "@/data/api-key.queries"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { getWorkspaceScope } from "@/data/workspaces"

export const unstable_instant = false

export default async function WorkspaceAPIKeysPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}) {
  const { orgSlug, workspaceSlug } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    return <ErrorPanel message="Workspace is unavailable" />
  }

  const includeAll = scope.scope.organization.superadmin || scope.workspace.can_administer

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-end">
        <Suspense fallback={<Button disabled>New API key</Button>}>
          <CreateAPIKeyAction workspaceId={scope.workspace.id} />
        </Suspense>
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <APIKeys workspaceId={scope.workspace.id} includeAll={includeAll} />
      </Suspense>
    </div>
  )
}

async function CreateAPIKeyAction({ workspaceId }: { workspaceId: string }) {
  const listedAgents = await listAgentsCachedQuery(undefined, workspaceId)
  if (listedAgents.error) {
    return null
  }

  const workflowsByAgent = await Promise.all(
    listedAgents.agents.map(async (agent) => {
      const workflowsResult = await listWorkflowSummariesCachedQuery(agent.name, workspaceId)
      return {
        agentName: agent.name,
        workflows: workflowsResult.error ? [] : workflowsResult.summaries,
      }
    })
  )

  return (
    <CreateAPIKeyButton
      agents={listedAgents.agents}
      workflowsByAgent={workflowsByAgent}
      createAPIKeyAction={createAPIKeyFormAction.bind(null, { workspaceId })}
    />
  )
}

async function APIKeys({
  includeAll,
  workspaceId,
}: {
  includeAll: boolean
  workspaceId: string
}) {
  const listedKeys = await listAPIKeysCachedQuery(workspaceId, includeAll)

  return (
    <APIKeysTable
      deleteAPIKeyAction={deleteAPIKeyFormAction.bind(null, { workspaceId })}
      keys={listedKeys.apiKeys}
    />
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Unable to load API keys</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
    </div>
  )
}
