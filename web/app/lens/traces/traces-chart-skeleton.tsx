import { Skeleton } from "@/components/ui/skeleton"

const bars = Array.from({ length: 25 }, (_, index) => index)

export function TracesChartSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4 px-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="flex h-56 items-end gap-1.5 rounded-md bg-muted/20 px-3 py-4">
        {bars.map((bar) => (
          <Skeleton
            key={bar}
            className="flex-1 rounded-t-md"
            style={{ height: `${24 + (bar % 7) * 9}%` }}
          />
        ))}
      </div>
    </section>
  )
}
