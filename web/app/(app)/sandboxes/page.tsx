import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import * as z from "zod"
import { Plus } from "lucide-react"
import { deleteSandboxFormAction } from "@/data/sandbox.actions"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { Button } from "@/components/ui/button"
import { SandboxTable } from "./sandbox-table"
import type { DeleteSandboxFormState } from "@/data/types"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Sandboxes",
}

const sandboxesSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
})

type SandboxesSearchParams = {
  page_token?: SearchParamStringInput
}

export default async function SandboxesPage({
  searchParams,
}: {
  searchParams: Promise<SandboxesSearchParams>
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Sandboxes</h1>
        </div>
        <Button asChild>
          <Link href="/sandboxes/new">
            <Plus />
            New sandbox
          </Link>
        </Button>
      </div>
      <Suspense fallback={<SandboxesSkeleton />}>
        <Sandboxes searchParams={searchParams} deleteSandboxAction={deleteSandboxFormAction} />
      </Suspense>
    </main>
  )
}

async function Sandboxes({
  searchParams,
  deleteSandboxAction,
}: {
  searchParams?: Promise<SandboxesSearchParams>
  deleteSandboxAction: (
    name: string,
    state: DeleteSandboxFormState,
    formData: FormData
  ) => Promise<DeleteSandboxFormState>
}) {
  const params = searchParams ? sandboxesSearchParamsSchema.parse(await searchParams) : undefined
  const result = await listSandboxesCachedQuery({ limit: 50, page_token: params?.page_token })

  if (result.error) {
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {result.error.message}
      </div>
    )
  }

  return (
    <SandboxTable
      sandboxes={result.sandboxes}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      deleteSandboxAction={deleteSandboxAction}
    />
  )
}

function SandboxesSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 md:px-6">
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
    </div>
  )
}
