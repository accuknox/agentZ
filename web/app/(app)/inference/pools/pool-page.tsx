import { Suspense } from "react"
import { AdministrationPageHeader } from "@/components/administration"
import { ErrorState } from "@/components/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { listInferencePoolsPageCachedQuery } from "@/data/inference-pool.queries"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { NewInferencePoolButton } from "./pool-sheet"
import { InferencePoolTable } from "./pool-table"
import type { InferencePoolActionScope } from "@/data/inference-pool.actions"
import type { ResourceCapabilities } from "@/lib/gateway/client"

export default function InferencePoolsPage({
  capabilities,
  pageToken,
  scope,
}: {
  capabilities: ResourceCapabilities
  pageToken?: string
  scope: InferencePoolActionScope
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <Suspense fallback={<PoolPageSkeleton />}>
        <Pools capabilities={capabilities} pageToken={pageToken} scope={scope} />
      </Suspense>
    </main>
  )
}

async function Pools({
  capabilities,
  pageToken,
  scope,
}: {
  capabilities: ResourceCapabilities
  pageToken?: string
  scope: InferencePoolActionScope
}) {
  const [pools, providers] = await Promise.all([
    listInferencePoolsPageCachedQuery({ limit: 50, page_token: pageToken }, scope.workspaceId),
    listInferenceProvidersCachedQuery(scope.workspaceId),
  ])
  if (pools.error) {
    return (
      <>
        <PageHeader />
        <ErrorState description={pools.error.message} />
      </>
    )
  }
  if (providers.error) {
    return (
      <>
        <PageHeader />
        <ErrorState description={providers.error.message} />
      </>
    )
  }
  return (
    <>
      <PageHeader
        action={
          capabilities.create ? (
            <NewInferencePoolButton providers={providers.providers} scope={scope} />
          ) : undefined
        }
      />
      <InferencePoolTable
        hasNextPage={pools.hasNextPage}
        nextPageToken={pools.nextPageToken}
        pools={pools.pools}
        providers={providers.providers}
        scope={scope}
      />
    </>
  )
}

function PageHeader({ action }: { action?: React.ReactNode }) {
  return <AdministrationPageHeader actions={action} title="Pools" />
}

function PoolPageSkeleton() {
  return (
    <>
      <PageHeader />
      <div className="flex flex-1 flex-col">
        <span role="status" className="sr-only">
          Loading Pools...
        </span>
        <div aria-hidden className="flex flex-1 flex-col">
          <div className="bg-muted/25 flex h-9 items-center gap-6 border-b px-4">
            {["w-28", "w-24", "w-36", "w-20", "w-32", "w-16", "w-20"].map((width, index) => (
              <Skeleton key={index} className={`h-3 ${width}`} />
            ))}
          </div>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex h-11 items-center gap-6 border-b px-4">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
