import { Suspense } from "react"
import Link from "next/link"
import * as z from "zod"
import { Plus } from "lucide-react"
import type { Route } from "next"
import { deleteSandboxFormAction } from "@/data/sandbox.actions"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { AdministrationPageHeader, type AdministrationPageScope } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { SandboxTable } from "./sandbox-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import type { ResourceCapabilities } from "@/lib/gateway/client"

const sandboxesSearchParamsSchema = z.object({
  page_token: searchParamStringSchema,
  sort_by: searchParamStringSchema.pipe(z.enum(["name", "created_at"]).default("name")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("asc")),
})

type SandboxesSearchParams = {
  page_token?: SearchParamStringInput
  sort_by?: SearchParamStringInput
  sort_order?: SearchParamStringInput
}

export default async function SandboxesPage({
  basePath,
  capabilities,
  pageScope,
  searchParams,
  workspaceId,
}: {
  basePath: string
  capabilities: ResourceCapabilities
  pageScope: AdministrationPageScope
  searchParams: Promise<SandboxesSearchParams>
  workspaceId?: string
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader
        actions={
          capabilities.create ? (
            <Button asChild>
              <Link href={`${basePath}/new` as Route}>
                <Plus />
                Add sandbox
              </Link>
            </Button>
          ) : undefined
        }
        scope={pageScope}
        title="Sandboxes"
      />
      <Suspense fallback={<SandboxesSkeleton />}>
        <Sandboxes basePath={basePath} searchParams={searchParams} workspaceId={workspaceId} />
      </Suspense>
    </main>
  )
}

async function Sandboxes({
  searchParams,
  basePath,
  workspaceId,
}: {
  basePath: string
  searchParams?: Promise<SandboxesSearchParams>
  workspaceId?: string
}) {
  const params = searchParams ? sandboxesSearchParamsSchema.parse(await searchParams) : undefined
  const result = await listSandboxesCachedQuery(
    {
      limit: 50,
      page_token: params?.page_token,
      sort_by: params?.sort_by,
      sort_order: params?.sort_order,
    },
    workspaceId
  )

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
      sortBy={params?.sort_by ?? "name"}
      sortOrder={params?.sort_order ?? "asc"}
      basePath={basePath}
      deleteSandboxAction={deleteSandboxFormAction.bind(null, { basePath, workspaceId })}
      showOrganization={workspaceId !== undefined}
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
