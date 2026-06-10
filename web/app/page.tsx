import type { Metadata } from "next"
import { Suspense } from "react"
import { connection } from "next/server"
import { deleteAgentFormAction } from "@/data/agent.actions"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { AgentTable } from "@/app/agent-table"
import { AgentDialog } from "@/app/agent/agent-dialog"
import type { DeleteAgentFormState } from "@/data/types"

export const metadata: Metadata = {
  title: "Agents | ClawArmor - AccuKnox",
}

export default function Home({
  searchParams,
}: {
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Agents</h1>
        </div>
        <Suspense fallback={null}>
          <EnvironmentsHeader />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <EnvironmentsInfo />
      </Suspense>
      <Suspense fallback={<AgentsSkeleton />}>
        <Agents searchParams={searchParams} deleteAgentAction={deleteAgentFormAction} />
      </Suspense>
    </main>
  )
}

async function EnvironmentsHeader() {
  await connection()
  const environments = await listEnvironmentsCachedQuery({ limit: 50 })
  if (environments.error) return null
  return (
    <AgentDialog
      mode="create"
      environments={environments.environments}
      initialHasNextEnvironmentPage={environments.hasNextPage}
      initialNextEnvironmentPageToken={environments.nextPageToken}
    />
  )
}

async function EnvironmentsInfo() {
  await connection()
  const environments = await listEnvironmentsCachedQuery({ limit: 50 })
  if (!environments.error) return null
  return (
    <div className="px-4 md:px-6">
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {environments.error.message}
      </div>
    </div>
  )
}

async function Agents({
  searchParams,
  deleteAgentAction,
}: {
  searchParams?: Promise<{ page_token?: string | string[] }>
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
}) {
  await connection()
  const params = searchParams ? await searchParams : undefined
  const pageToken = Array.isArray(params?.page_token) ? params?.page_token[0] : params?.page_token
  const [result, environments] = await Promise.all([
    listAgentsCachedQuery({ limit: 50, page_token: pageToken }),
    listEnvironmentsCachedQuery({ limit: 50 }),
  ])

  if (result.error) {
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {result.error.message}
      </div>
    )
  }

  return (
    <AgentTable
      agents={result.agents}
      environments={environments.error ? [] : environments.environments}
      hasNextPage={result.hasNextPage}
      initialHasNextEnvironmentPage={environments.error ? false : environments.hasNextPage}
      initialNextEnvironmentPageToken={environments.error ? "" : environments.nextPageToken}
      nextPageToken={result.nextPageToken}
      deleteAgentAction={deleteAgentAction}
    />
  )
}

function AgentsSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 md:px-6">
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
    </div>
  )
}
