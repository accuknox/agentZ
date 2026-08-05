import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import * as z from "zod"
import { Plus } from "lucide-react"
import type { Route } from "next"
import { deleteSandboxFormAction } from "@/data/sandbox.actions"
import { listSandboxesCachedQuery } from "@/data/sandbox.queries"
import { Button } from "@/components/ui/button"
import { SandboxTable } from "./sandbox-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import type { ResourceCapabilities } from "@/lib/gateway/client"
import { Badge } from "@/components/ui/badge"

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
  basePath,
  capabilities,
  scopeLabel,
  searchParams,
  workspaceId,
}: {
  basePath: string
  capabilities: ResourceCapabilities
  scopeLabel: "Local" | "Organisation"
  searchParams: Promise<SandboxesSearchParams>
  workspaceId?: string
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-normal">Sandboxes</h1>
            <Badge variant="outline">{scopeLabel}</Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Sandbox access includes locked read dependencies for its MCP connections, skills, and
            inference resources.
          </p>
        </div>
        {capabilities.create ? (
          <Button asChild>
            <Link href={`${basePath}/new` as Route}>
              <Plus />
              New sandbox
            </Link>
          </Button>
        ) : null}
      </div>
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
    { limit: 50, page_token: params?.page_token },
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
      basePath={basePath}
      deleteSandboxAction={deleteSandboxFormAction.bind(null, { basePath, workspaceId })}
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
