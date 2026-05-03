import { Skeleton } from "@/components/ui/skeleton"

export function TelemetryChartSkeleton() {
  return (
    <section className="flex flex-col gap-2 py-3 px-6">
      <div className="flex items-center justify-end">
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="flex h-40 items-end gap-1.5 rounded-md bg-muted/20 px-3 py-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t-md"
            style={{ height: `${20 + (i % 5) * 15}%` }}
          />
        ))}
      </div>
    </section>
  )
}
