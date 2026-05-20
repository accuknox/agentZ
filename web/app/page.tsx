import { deleteAgentFormAction } from "@/data/agent.actions"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { AgentTable } from "@/app/agent-table"
import { AgentDialog } from "@/app/agent/agent-dialog"
import type { DeleteAgentFormState } from "@/data/types"
import type { Environment } from "@/lib/gateway/client"

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  const environments = await listEnvironmentsCachedQuery({ limit: 50 })

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Agents</h1>
        </div>
        {environments.error ? null : (
          <AgentDialog
            mode="create"
            environments={environments.environments}
            initialHasNextEnvironmentPage={environments.hasNextPage}
            initialNextEnvironmentPageToken={environments.nextPageToken}
          />
        )}
      </div>
      {environments.error ? (
        <div className="px-4 md:px-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {environments.error.message}
          </div>
        </div>
      ) : null}
      <Agents
        environments={environments.error ? [] : environments.environments}
        initialHasNextEnvironmentPage={environments.error ? false : environments.hasNextPage}
        initialNextEnvironmentPageToken={environments.error ? "" : environments.nextPageToken}
        searchParams={searchParams}
        deleteAgentAction={deleteAgentFormAction}
      />
    </main>
  )
}

async function Agents({
  environments,
  initialHasNextEnvironmentPage,
  initialNextEnvironmentPageToken,
  searchParams,
  deleteAgentAction,
}: {
  environments: Environment[]
  initialHasNextEnvironmentPage: boolean
  initialNextEnvironmentPageToken: string
  searchParams?: Promise<{ page_token?: string | string[] }>
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
}) {
  const params = searchParams ? await searchParams : undefined
  const pageToken = Array.isArray(params?.page_token) ? params?.page_token[0] : params?.page_token
  const result = await listAgentsCachedQuery({ limit: 50, page_token: pageToken })

  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {result.error.message}
      </div>
    )
  }

  return (
    <AgentTable
      agents={result.agents}
      environments={environments}
      hasNextPage={result.hasNextPage}
      initialHasNextEnvironmentPage={initialHasNextEnvironmentPage}
      initialNextEnvironmentPageToken={initialNextEnvironmentPageToken}
      nextPageToken={result.nextPageToken}
      deleteAgentAction={deleteAgentAction}
    />
  )
}
