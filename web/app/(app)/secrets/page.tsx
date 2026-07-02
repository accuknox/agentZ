import type { Metadata } from "next"
import { Suspense } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import {
  deleteSecretFormAction,
  putSecretFormAction,
  startOAuthSecretFormAction,
} from "@/data/secret.actions"
import { listSecretsCachedQuery } from "@/data/secret.queries"
import { SecretsFilters } from "./secrets-filters"
import { NewSecretButton } from "./new-secret-button"
import { SecretTable } from "./secret-table"

export const metadata: Metadata = {
  title: "Secrets",
}

type SearchParams = {
  page_token?: string | string[]
  agent_name?: string | string[]
}

export default async function SecretsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Secrets</h1>
        </div>
        <Suspense
          fallback={
            <Button disabled>
              <Plus />
              Create
            </Button>
          }
        >
          <NewSecretButtonShell
            searchParams={params}
            putSecretAction={putSecretFormAction}
            startOAuthAction={startOAuthSecretFormAction}
          />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={params} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Secrets searchParams={params} deleteSecretAction={deleteSecretFormAction} />
      </Suspense>
    </main>
  )
}

async function NewSecretButtonShell({
  searchParams,
  putSecretAction,
  startOAuthAction,
}: {
  searchParams: SearchParams
  putSecretAction: typeof putSecretFormAction
  startOAuthAction: typeof startOAuthSecretFormAction
}) {
  const agents = listAgentsCachedQuery()
  const agentName = Array.isArray(searchParams.agent_name)
    ? searchParams.agent_name[0]
    : searchParams.agent_name
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return (
      <Button disabled>
        <Plus />
        Create
      </Button>
    )
  }

  const selectedAgent = result.agents.find((agent) => agent.name === agentName) ?? result.agents[0]

  return (
    <NewSecretButton
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      putSecretAction={putSecretAction}
      startOAuthAction={startOAuthAction}
    />
  )
}

async function Filters({ searchParams }: { searchParams: SearchParams }) {
  const agents = listAgentsCachedQuery()
  const agentName = Array.isArray(searchParams.agent_name)
    ? searchParams.agent_name[0]
    : searchParams.agent_name
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return <FiltersSkeleton />
  }

  const selectedAgent = result.agents.find((agent) => agent.name === agentName) ?? result.agents[0]

  return <SecretsFilters agents={result.agents} selectedAgentName={selectedAgent.name} />
}

async function Secrets({
  searchParams,
  deleteSecretAction,
}: {
  searchParams: SearchParams
  deleteSecretAction: typeof deleteSecretFormAction
}) {
  const agents = listAgentsCachedQuery()
  const agentName = Array.isArray(searchParams.agent_name)
    ? searchParams.agent_name[0]
    : searchParams.agent_name
  const pageToken = Array.isArray(searchParams.page_token)
    ? searchParams.page_token[0]
    : searchParams.page_token
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selectedAgent =
    agentsResult.agents.find((agent) => agent.name === agentName) ?? agentsResult.agents[0]
  if (!selectedAgent) {
    return <EmptyState message="No agents available" />
  }

  const result = await listSecretsCachedQuery(selectedAgent.name, {
    limit: 50,
    page_token: pageToken,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <SecretTable
      agentName={selectedAgent.name}
      secrets={result.items}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteSecretAction={deleteSecretAction}
    />
  )
}

function FiltersSkeleton() {
  return <div className="bg-muted/20 h-15 border-b" />
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="bg-muted/20 h-8 w-full rounded" />
      <div className="bg-muted/20 h-8 w-full rounded" />
      <div className="bg-muted/20 h-8 w-full rounded" />
      <div className="bg-muted/20 h-8 w-full rounded" />
      <div className="bg-muted/20 h-8 w-full rounded" />
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="bg-destructive/5 text-destructive m-6 rounded-md p-4 text-sm">{message}</div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      {message}
    </div>
  )
}
