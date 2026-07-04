import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
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
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Secrets",
}

const secretsSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
  agent_name: searchParamStringSchema,
})

type SearchParams = {
  page_token?: SearchParamStringInput
  agent_name?: SearchParamStringInput
}

type ResolvedSearchParams = z.output<typeof secretsSearchParamsSchema>

export default async function SecretsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = secretsSearchParamsSchema.parse(await searchParams)

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
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
  searchParams: ResolvedSearchParams
  putSecretAction: typeof putSecretFormAction
  startOAuthAction: typeof startOAuthSecretFormAction
}) {
  const agents = listAgentsCachedQuery()
  const agentName = searchParams.agent_name
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return (
      <Button disabled>
        <Plus />
        Create
      </Button>
    )
  }

  const firstAgent = result.agents[0]
  if (!firstAgent) {
    return (
      <Button disabled>
        <Plus />
        Create
      </Button>
    )
  }

  const selectedAgent = result.agents.find((agent) => agent.name === agentName) ?? firstAgent

  return (
    <NewSecretButton
      key={selectedAgent.name}
      agentName={selectedAgent.name}
      putSecretAction={putSecretAction}
      startOAuthAction={startOAuthAction}
    />
  )
}

async function Filters({ searchParams }: { searchParams: ResolvedSearchParams }) {
  const agents = listAgentsCachedQuery()
  const agentName = searchParams.agent_name
  const result = await agents
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  const selectedAgent = result.agents.find((agent) => agent.name === agentName) ?? result.agents[0]

  return <SecretsFilters agents={result.agents} selectedAgentName={selectedAgent?.name} />
}

async function Secrets({
  searchParams,
  deleteSecretAction,
}: {
  searchParams: ResolvedSearchParams
  deleteSecretAction: typeof deleteSecretFormAction
}) {
  const agents = listAgentsCachedQuery()
  const agentName = searchParams.agent_name
  const pageToken = searchParams.page_token
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
