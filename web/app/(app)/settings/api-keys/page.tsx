import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { createAPIKeyFormAction, deleteAPIKeyFormAction } from "@/data/api-key.actions"
import { listWorkflowSummariesCachedQuery } from "@/data/workflow.queries"
import { Button } from "@/components/ui/button"
import { getAuth } from "@/lib/auth"
import { currentGatewayAuthContext } from "@/lib/gateway/auth"
import { CreateAPIKeyButton } from "./dialog"
import { APIKeysTable } from "./table"

export const metadata: Metadata = {
  title: "API Keys",
}

export default function APIKeysPage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">API Keys</h1>
        </div>
        <Suspense fallback={<CreateAPIKeyButtonFallback />}>
          <CreateAPIKeyAction />
        </Suspense>
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <APIKeys />
      </Suspense>
    </main>
  )
}

async function CreateAPIKeyAction() {
  const listedAgents = await listAgentsCachedQuery()
  if (listedAgents.error) {
    return null
  }

  const workflowsByAgent = await Promise.all(
    listedAgents.agents.map(async (agent) => {
      const workflowsResult = await listWorkflowSummariesCachedQuery(agent.name)
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
      createAPIKeyAction={createAPIKeyFormAction}
    />
  )
}

async function APIKeys() {
  await connection()
  const auth = getAuth()
  const authContext = await currentGatewayAuthContext()
  const requestHeaders = await headers()
  const listedKeys = await auth.api.listApiKeys({
    headers: requestHeaders,
    query: {
      organizationId: authContext.organizationId,
      sortBy: "createdAt",
      sortDirection: "desc",
    },
  })

  return <APIKeysTable deleteAPIKeyAction={deleteAPIKeyFormAction} keys={listedKeys.apiKeys} />
}

function CreateAPIKeyButtonFallback() {
  return <Button disabled>New API key</Button>
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
