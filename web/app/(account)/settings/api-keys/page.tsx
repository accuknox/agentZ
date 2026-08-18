import type { Metadata } from "next"
import { Suspense } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { createAPIKeyFormAction, deleteUserAPIKeyFormAction } from "@/data/api-key.actions"
import { listUserAPIKeysCachedQuery } from "@/data/api-key.queries"
import { getOrganizationSession } from "@/data/organizations"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { getWorkspaceDirectory } from "@/data/workspaces"
import { CreateAPIKeyButton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/api-keys/dialog"
import { APIKeysTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/api-keys/table"
import { APIKeyWorkspaceMenu } from "./api-key-menu"

export const metadata: Metadata = { title: "API keys" }

export default async function APIKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ create?: string }>
}) {
  const { create } = await searchParams
  const context = await getAPIKeyContext()
  const selected = context.workspaces.find((workspace) => workspace.id === create)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <header className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">API keys</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Personal credentials for Agents and workflow webhooks you can access.
          </p>
        </div>
        <APIKeyWorkspaceMenu workspaces={context.workspaces} />
      </header>
      {!context.workspaces.length ? (
        <Alert className="rounded-none border-x-0 px-4 md:px-6">
          <AlertTitle>No eligible Workspaces</AlertTitle>
          <AlertDescription>
            You need access to a ready Workspace with at least one Agent before creating an API key.
          </AlertDescription>
        </Alert>
      ) : null}
      {selected ? <CreateDialog workspace={selected} /> : null}
      <Suspense fallback={<TableSkeleton />}>
        <PersonalAPIKeys />
      </Suspense>
    </main>
  )
}

async function getAPIKeyContext() {
  const session = await getOrganizationSession()
  const activeId = session?.session.session.activeOrganizationId
  const organization = session?.organizations.find((item) => item.id === activeId)
  if (!organization?.hasAccess) return { workspaces: [] }
  const result = await getWorkspaceDirectory(organization.slug)
  if (!result.directory) return { workspaces: [] }
  const ready = result.directory.workspaces.filter((workspace) => workspace.state === "ready")
  const eligible = await Promise.all(
    ready.map(async (workspace) => ({
      workspace,
      agents: await listAgentsCachedQuery(undefined, workspace.id),
    }))
  )
  return {
    workspaces: eligible
      .filter(({ agents }) => !agents.error && agents.agents.length > 0)
      .map(({ workspace }) => workspace),
  }
}

async function CreateDialog({ workspace }: { workspace: { id: string; name: string } }) {
  const agents = await listAgentsCachedQuery(undefined, workspace.id)
  if (agents.error || !agents.agents.length) return null
  const workflowsByAgent = await Promise.all(
    agents.agents.map(async (agent) => {
      const result = await listWorkflowSummariesCachedQuery(agent.name, workspace.id)
      return { agentName: agent.name, workflows: result.error ? [] : result.summaries }
    })
  )

  return (
    <CreateAPIKeyButton
      agents={agents.agents}
      createAPIKeyAction={createAPIKeyFormAction.bind(null, { workspaceId: workspace.id })}
      openInitially
      showTrigger={false}
      workflowsByAgent={workflowsByAgent}
      workspaceName={workspace.name}
    />
  )
}

async function PersonalAPIKeys() {
  const keys = await listUserAPIKeysCachedQuery()
  return <APIKeysTable canDelete deleteAPIKeyAction={deleteUserAPIKeyFormAction} keys={keys} />
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 md:px-6">
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
    </div>
  )
}
