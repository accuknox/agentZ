import { Skeleton } from "@/components/ui/skeleton"
import { TracesSkeleton } from "@/app/lens/traces/traces-skeleton"

export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-5 p-4 pt-0 md:p-6 md:pt-0">
      <div className="flex items-end justify-between gap-4">
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-16 rounded-lg" />
      <TracesSkeleton />
    </main>
  )
}
