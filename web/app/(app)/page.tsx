import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { deleteAgentFormAction } from "@/data/agent.actions"
import { listAgentsCachedQuery } from "@/data/agent.queries"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { AgentTable } from "@/app/agent-table"
import { AgentDialog } from "@/app/agent/agent-dialog"
import { BotIcon } from "@/components/bot-icon"
import type { DeleteAgentFormState } from "@/data/types"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

const homeSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
})

type HomeSearchParams = {
  page_token?: SearchParamStringInput
}

export default async function Home({ searchParams }: { searchParams: Promise<HomeSearchParams> }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 items-center gap-3">
          <BotIcon
            aria-hidden="true"
            className="text-primary flex size-10 shrink-0 items-center justify-center rounded-md"
            size={24}
          />
          <h1 className="text-2xl font-semibold tracking-normal">Agents</h1>
        </div>
        <Suspense fallback={null}>
          <SandboxesHeader />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <SandboxesInfo />
      </Suspense>
      <Suspense fallback={<AgentsSkeleton />}>
        <Agents searchParams={searchParams} deleteAgentAction={deleteAgentFormAction} />
      </Suspense>
    </main>
  )
}

async function SandboxesHeader() {
  const sandboxes = await listSandboxesCachedQuery({ limit: 50 })
  if (sandboxes.error) return null
  return (
    <AgentDialog
      mode="create"
      sandboxes={sandboxes.sandboxes}
      initialHasNextSandboxPage={sandboxes.hasNextPage}
      initialNextSandboxPageToken={sandboxes.nextPageToken}
    />
  )
}

async function SandboxesInfo() {
  const sandboxes = await listSandboxesCachedQuery({ limit: 50 })
  if (!sandboxes.error) return null
  return (
    <div className="px-4 md:px-6">
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {sandboxes.error.message}
      </div>
    </div>
  )
}

async function Agents({
  searchParams,
  deleteAgentAction,
}: {
  searchParams?: Promise<HomeSearchParams>
  deleteAgentAction: (
    agentName: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
}) {
  const params = searchParams ? homeSearchParamsSchema.parse(await searchParams) : undefined
  const [result, sandboxes] = await Promise.all([
    listAgentsCachedQuery({ limit: 50, page_token: params?.page_token }),
    listSandboxesCachedQuery({ limit: 50 }),
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
      sandboxes={sandboxes.error ? [] : sandboxes.sandboxes}
      hasNextPage={result.hasNextPage}
      initialHasNextSandboxPage={sandboxes.error ? false : sandboxes.hasNextPage}
      initialNextSandboxPageToken={sandboxes.error ? "" : sandboxes.nextPageToken}
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
