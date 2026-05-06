import { Suspense } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listAgentsAction } from "@/data/agent.actions"
import {
  deleteSecretFormAction,
  listSecretsAction,
  putSecretFormAction,
} from "@/data/secret.actions"
import type { ListAgentActionResponse } from "@/data/types"
import { SecretsFilters } from "./secrets-filters"
import { NewSecretButton } from "./new-secret-button"
import { SecretTable } from "./secret-table"

function firstSearchParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

type SearchParams = {
  page_token?: string | string[]
  session_id?: string | string[]
}

export default async function SecretsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const agents = listAgentsAction()
  const pageToken = firstSearchParam(params.page_token)
  const sessionID = firstSearchParam(params.session_id)

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
        <Filters agents={agents} sessionID={sessionID} />
      </Suspense>
      <Suspense
        key={`table-${sessionID ?? "default"}-${pageToken ?? ""}`}
        fallback={<TableSkeleton />}
      >
        <Secrets
          agents={agents}
          sessionID={sessionID}
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

  return (
    <NewSecretButton sessionID={result.agents[0].session_id} putSecretAction={putSecretAction} />
  )
}

async function Filters({
  agents,
  sessionID,
}: {
  agents: Promise<ListAgentActionResponse>
  sessionID?: string
}) {
  const result = await agents
  if (result.error || !result.agents || result.agents.length === 0) {
    return <FiltersSkeleton />
  }

  return (
    <SecretsFilters
      agents={result.agents}
      selectedSessionID={selectedSessionID(result, sessionID)}
    />
  )
}

async function Secrets({
  agents,
  sessionID,
  pageToken,
  deleteSecretAction,
  putSecretAction,
}: {
  agents: Promise<ListAgentActionResponse>
  sessionID?: string
  pageToken?: string
  deleteSecretAction: typeof deleteSecretFormAction
  putSecretAction: typeof putSecretFormAction
}) {
  const agentsResult = await agents
  const selected = selectedSessionID(agentsResult, sessionID)

  if (agentsResult.error) {
    return <ErrorPanel message={agentsResult.error.message} />
  }

  if (!selected) {
    return <EmptyState message="No agents available" />
  }

  const result = await listSecretsAction(selected, {
    limit: 50,
    page_token: pageToken,
  })

  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }

  return (
    <SecretTable
      sessionID={selected}
      secrets={result.items}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteSecretAction={deleteSecretAction}
      putSecretAction={putSecretAction}
    />
  )
}

function selectedSessionID(result: ListAgentActionResponse, sessionID?: string) {
  if (result.error || !result.agents) {
    return undefined
  }

  return sessionID ?? result.agents[0]?.session_id
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
