import type { Metadata } from "next"
import { Suspense } from "react"
import { CircleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { listInferenceProvidersCachedQuery } from "@/data/inference-provider.queries"
import { NewInferenceProviderButton } from "./new-provider-button"
import { InferenceProviderTable } from "./provider-table"
import type { ResourceCapabilities } from "@/lib/gateway/client"
import type { InferenceProviderActionScope } from "@/data/inference-provider.actions"
import { Badge } from "@/components/ui/badge"

export const metadata: Metadata = { title: "Providers" }

export default function InferenceProvidersPage({
  capabilities,
  scope,
  scopeLabel,
}: {
  capabilities: ResourceCapabilities
  scope: InferenceProviderActionScope
  scopeLabel: "Local" | "Organisation"
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-normal">Providers</h1>
            <Badge variant="outline">{scopeLabel}</Badge>
          </div>
        </div>
        {capabilities.create ? <NewInferenceProviderButton scope={scope} /> : null}
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <Providers scope={scope} />
      </Suspense>
    </main>
  )
}

async function Providers({ scope }: { scope: InferenceProviderActionScope }) {
  const result = await listInferenceProvidersCachedQuery(scope.workspaceId)
  if (result.error) {
    return <ErrorPanel message={result.error.message} />
  }
  return <InferenceProviderTable providers={result.providers} scope={scope} />
}

function TableSkeleton() {
  return (
    <div className="flex flex-1 flex-col">
      <span role="status" className="sr-only">
        Loading providers…
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
    <Alert variant="destructive" className="mx-4 w-auto md:mx-6">
      <CircleAlert />
      <AlertTitle>Could not load inference providers</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
