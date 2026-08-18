import { Skeleton } from "@/components/ui/skeleton"

export function EventsChartSkeleton() {
  return (
    <section className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:px-6">
      <div className="flex items-center justify-end">
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="bg-muted/20 flex h-40 items-end gap-1.5 rounded-md px-3 py-4">
        {Array.from({ length: 25 }, (_, index) => (
          <Skeleton
            key={index}
            className="flex-1 rounded-t-md"
            style={{ height: `${20 + (index % 5) * 15}%` }}
          />
        ))}
      </div>
    </section>
  )
}
