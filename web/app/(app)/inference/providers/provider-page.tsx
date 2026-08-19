import { Suspense } from "react"
import { CircleAlert } from "lucide-react"
import { AdministrationPageHeader, type AdministrationPageScope } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { listInferenceProvidersPageCachedQuery } from "@/data/inference-provider.queries"
import { NewInferenceProviderButton } from "./new-provider-button"
import { InferenceProviderTable } from "./provider-table"
import type { ResourceCapabilities } from "@/lib/gateway/client"
import type { InferenceProviderActionScope } from "@/data/inference-provider.actions"
import { resourceLabels } from "@/lib/resource-labels"

export default function InferenceProvidersPage({
  capabilities,
  pageToken,
  pageScope,
  scope,
}: {
  capabilities: ResourceCapabilities
  pageToken?: string
  pageScope: AdministrationPageScope
  scope: InferenceProviderActionScope
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader
        actions={capabilities.create ? <NewInferenceProviderButton scope={scope} /> : undefined}
        scope={pageScope}
        title={resourceLabels.inference.collection}
      />
      <Suspense fallback={<TableSkeleton />}>
        <Providers canCreate={capabilities.create} pageToken={pageToken} scope={scope} />
      </Suspense>
    </main>
  )
}

async function Providers({
  canCreate,
  pageToken,
  scope,
}: {
  canCreate: boolean
  pageToken?: string
  scope: InferenceProviderActionScope
}) {
  const result = await listInferenceProvidersPageCachedQuery(
    { limit: 50, page_token: pageToken },
    scope.workspaceId
  )
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }
  return (
    <InferenceProviderTable
      canCreate={canCreate}
      hasNextPage={result.hasNextPage}
      nextPageToken={result.nextPageToken}
      providers={result.providers}
      scope={scope}
    />
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col">
      <span role="status" className="sr-only">
        Loading providers...
      </span>
      <div aria-hidden className="flex flex-1 flex-col">
        <div className="bg-muted/25 flex h-9 items-center gap-6 border-b px-4">
          {["w-32", "w-24", "w-20", "w-16", "w-20", "w-16"].map((width, index) => (
            <Skeleton key={index} className={`h-3 ${width}`} />
          ))}
        </div>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex h-11 items-center gap-6 border-b px-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <Alert className="px-4 md:px-6" variant="destructive">
      <CircleAlert />
      <AlertTitle>Could not load inference providers</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
