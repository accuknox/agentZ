import { Suspense } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { deleteSecretFormAction, putSecretFormAction } from "@/data/secret.actions"
import { listSecretsCachedQuery } from "@/data/secret.queries"
import type { ListAgentActionResponse } from "@/data/types"
import { firstSearchParam } from "@/lib/search-params"
import { SecretsFilters } from "./secrets-filters"
import { NewSecretButton } from "./new-secret-button"
import { SecretTable } from "./secret-table"

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
  const agents = listAgentsCachedQuery()
  const pageToken = firstSearchParam(params.page_token)
  const agentName = firstSearchParam(params.agent_name)

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
          <NewSecretButtonShell agents={agents} putSecretAction={putSecretFormAction} />
        </Suspense>
      </div>
      <Suspense fallback={<FiltersSkeleton />}>
        <Filters agents={agents} agentName={agentName} />
      </Suspense>
      <Suspense
        key={`table-${agentName ?? "default"}-${pageToken ?? ""}`}
        fallback={<TableSkeleton />}
      >
        <Secrets
          agents={agents}
          agentName={agentName}
          pageToken={pageToken}
          deleteSecretAction={deleteSecretFormAction}
          putSecretAction={putSecretFormAction}
        />
      </Suspense>
    </main>
  )
}

async function NewSecretButtonShell({
  agents,
  putSecretAction,
}: {
  agents: Promise<ListAgentActionResponse>
  putSecretAction: typeof putSecretFormAction
}) {
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

async function Filters({
  agents,
  agentName,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
}) {
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
  agents,
  agentName,
  pageToken,
  deleteSecretAction,
  putSecretAction,
}: {
  agents: Promise<ListAgentActionResponse>
  agentName?: string
  pageToken?: string
  deleteSecretAction: typeof deleteSecretFormAction
  putSecretAction: typeof putSecretFormAction
}) {
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
  return <div className="h-15 border-b bg-muted/20" />
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="h-8 w-full rounded bg-muted/20" />
      <div className="h-8 w-full rounded bg-muted/20" />
      <div className="h-8 w-full rounded bg-muted/20" />
      <div className="h-8 w-full rounded bg-muted/20" />
      <div className="h-8 w-full rounded bg-muted/20" />
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="m-6 rounded-md bg-destructive/5 p-4 text-sm text-destructive">{message}</div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}
