import { AdministrationPageHeader } from "@/components/administration"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import { TracesSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/traces/traces-skeleton"

export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="Traces" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
          <Skeleton className="h-8 w-full sm:w-64" />
          <Skeleton className="h-8 w-full sm:w-72" />
          <Skeleton className="h-8 w-full sm:w-72" />
        </div>
        <EventsChartSkeleton />
        <TracesSkeleton />
      </div>
    </main>
  )
}
