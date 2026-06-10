import type { Metadata } from "next"
import { Suspense } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { connection } from "next/server"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { deleteSecretFormAction, putSecretFormAction } from "@/data/secret.actions"
import { listSecretsCachedQuery } from "@/data/secret.queries"
import { firstSearchParam } from "@/lib/search-params"
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

export default function SecretsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
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
              New secret
            </Button>
          }
        >
          <NewSecretButtonShell putSecretAction={putSecretFormAction} />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<TableSkeleton />}>
        <Secrets
          searchParams={searchParams}
          deleteSecretAction={deleteSecretFormAction}
          putSecretAction={putSecretFormAction}
        />
      </Suspense>
    </main>
  )
}

async function NewSecretButtonShell({
  putSecretAction,
}: {
  putSecretAction: typeof putSecretFormAction
}) {
  await connection()
  const agents = listAgentsCachedQuery()
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return (
      <Button disabled>
        <Plus />
        New secret
      </Button>
    )
  }

  return <NewSecretButton agentName={result.agents[0].name} putSecretAction={putSecretAction} />
}

async function Filters({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection()
  const agents = listAgentsCachedQuery()
  const params = await searchParams
  const agentName = firstSearchParam(params.agent_name)
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return <FiltersSkeleton />
  }

  return (
    <SecretsFilters
      agents={result.agents}
      selectedAgentName={agentName ?? result.agents[0]?.name}
    />
  )
}

async function Secrets({
  searchParams,
  deleteSecretAction,
  putSecretAction,
}: {
  searchParams: Promise<SearchParams>
  deleteSecretAction: typeof deleteSecretFormAction
  putSecretAction: typeof putSecretFormAction
}) {
  await connection()
  const agents = listAgentsCachedQuery()
  const params = await searchParams
  const agentName = firstSearchParam(params.agent_name)
  const pageToken = firstSearchParam(params.page_token)
  const agentsResult = await agents
  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  const selected = agentName ?? agentsResult.agents[0]?.name
  if (!selected) {
    return <EmptyState message="No agents available" />
  }

  const result = await listSecretsCachedQuery(selected, {
    limit: 50,
    page_token: pageToken,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <SecretTable
      agentName={selected}
      secrets={result.items}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteSecretAction={deleteSecretAction}
      putSecretAction={putSecretAction}
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
