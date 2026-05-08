import Link from "next/link"
import { Plus } from "lucide-react"
import { deleteEnvironmentFormAction } from "@/data/environment.actions"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { Button } from "@/components/ui/button"
import { EnvironmentTable } from "./environment-table"
import type { DeleteEnvironmentFormState } from "@/data/types"

export default function EnvironmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page_token?: string | string[] }>
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Environments</h1>
        </div>
        <Button asChild>
          <Link href="/environments/new">
            <Plus />
            New environment
          </Link>
        </Button>
      </div>
      <Environments
        searchParams={searchParams}
        deleteEnvironmentAction={deleteEnvironmentFormAction}
      />
    </main>
  )
}

async function Environments({
  searchParams,
  deleteEnvironmentAction,
}: {
  searchParams?: Promise<{ page_token?: string | string[] }>
  deleteEnvironmentAction: (
    name: string,
    state: DeleteEnvironmentFormState,
    formData: FormData
  ) => Promise<DeleteEnvironmentFormState>
}) {
  const params = searchParams ? await searchParams : undefined
  const pageToken = Array.isArray(params?.page_token) ? params?.page_token[0] : params?.page_token
  const result = await listEnvironmentsCachedQuery({ limit: 50, page_token: pageToken })

  if (result.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {result.error.message}
      </div>
    )
  }

  return (
    <EnvironmentTable
      environments={result.environments}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteEnvironmentAction={deleteEnvironmentAction}
    />
  )
}
