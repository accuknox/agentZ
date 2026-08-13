import type { Metadata } from "next"
import { Suspense } from "react"
import { CircleAlert } from "lucide-react"
import { AdministrationPageHeader } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { listInferencePoolsCachedQuery } from "@/data/inference-pool.queries"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { NewInferencePoolButton } from "./pool-sheet"
import { InferencePoolTable } from "./pool-table"
import type { InferencePoolActionScope } from "@/data/inference-pool.actions"
import type { ResourceCapabilities } from "@/lib/gateway/client"

export const metadata: Metadata = { title: "Pools" }

export default function InferencePoolsPage({
  capabilities,
  scope,
}: {
  capabilities: ResourceCapabilities
  scope: InferencePoolActionScope
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <Suspense fallback={<PoolPageSkeleton />}>
        <Pools capabilities={capabilities} scope={scope} />
      </Suspense>
    </main>
  )
}

async function Pools({
  capabilities,
  scope,
}: {
  capabilities: ResourceCapabilities
  scope: InferencePoolActionScope
}) {
  const [pools, providers] = await Promise.all([
    listInferencePoolsCachedQuery(scope.workspaceId),
    listInferenceProvidersCachedQuery(scope.workspaceId),
  ])
  if (pools.error) {
    return (
      <>
        <PageHeader />
        <Alert variant="destructive" className="mx-4 w-auto md:mx-6">
          <CircleAlert />
          <AlertTitle>Could not load inference Pools</AlertTitle>
          <AlertDescription>{pools.error.message}</AlertDescription>
        </Alert>
      </>
    )
  }
  if (providers.error) {
    return (
      <>
        <PageHeader />
        <Alert variant="destructive" className="mx-4 w-auto md:mx-6">
          <CircleAlert />
          <AlertTitle>Could not load inference providers</AlertTitle>
          <AlertDescription>{providers.error.message}</AlertDescription>
        </Alert>
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
      <InferencePoolTable pools={pools.pools} providers={providers.providers} scope={scope} />
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
