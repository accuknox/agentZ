import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CreateAPIKeyButton } from "./dialog"
import { APIKeysTable } from "./table"
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
  if (!scope.workspace.api_key_capabilities.read) {
    return <ErrorPanel message="You cannot read API keys in this Workspace." />
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          scope.workspace.api_key_capabilities.create ? (
            <Suspense fallback={<Button disabled>New API key</Button>}>
              <CreateAPIKeyAction workspaceId={scope.workspace.id} />
            </Suspense>
          ) : undefined
        }
        title="API keys"
      />
      <Suspense fallback={<TableSkeleton />}>
        <APIKeys workspaceId={scope.workspace.id} />
      </Suspense>
    </div>
  )
}

async function CreateAPIKeyAction({ workspaceId }: { workspaceId: string }) {
  const listedAgents = await listAgentsCachedQuery(undefined, workspaceId)
  if (listedAgents.error) {
    return <ErrorPanel message="Eligible Agent targets are unavailable." />
  }
  if (listedAgents.agents.length === 0) {
    return (
      <Alert>
        <AlertTitle>No eligible targets</AlertTitle>
        <AlertDescription>
          API keys require access to at least one Agent or workflow in this Workspace.
        </AlertDescription>
      </Alert>
    )
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

async function APIKeys({ workspaceId }: { workspaceId: string }) {
  const listedKeys = await listAPIKeysCachedQuery(workspaceId)

  return (
    <APIKeysTable
      canDelete={listedKeys.access?.capabilities.delete ?? false}
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
