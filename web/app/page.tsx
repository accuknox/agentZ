import Link from "next/link"
import { Plus } from "lucide-react"
import { deleteAgentFormAction, listAgentsAction } from "@/data/agent.actions"
import { Button } from "@/components/ui/button"
import { AgentTable } from "@/app/agent-table"
import type { DeleteAgentFormState } from "@/data/types"

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
        <Button asChild>
          <Link href="/agent/new">
            <Plus />
            New agent
          </Link>
        </Button>
      </div>
      <Agents searchParams={searchParams} deleteAgentAction={deleteAgentFormAction} />
    </main>
  )
}

async function Agents({
  searchParams,
  deleteAgentAction,
}: {
  searchParams?: Promise<{ page_token?: string | string[] }>
  deleteAgentAction: (
    sessionID: string,
    state: DeleteAgentFormState,
    formData: FormData
  ) => Promise<DeleteAgentFormState>
}) {
  const params = searchParams ? await searchParams : undefined
  const pageToken = Array.isArray(params?.page_token) ? params?.page_token[0] : params?.page_token
  const result = await listAgentsAction(true, { limit: 50, page_token: pageToken })

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
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteAgentAction={deleteAgentAction}
    />
  )
}
