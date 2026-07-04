import { Skeleton } from "@/components/ui/skeleton"
import { TracesChartSkeleton } from "@/app/(app)/lens/traces/traces-chart-skeleton"
import { TracesSkeleton } from "@/app/(app)/lens/traces/traces-skeleton"

export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <div className="flex items-center justify-between px-4 sm:px-6">
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="bg-muted/20 h-15 border-b" />
      <TracesChartSkeleton />
      <TracesSkeleton />
    </main>
  )
}
