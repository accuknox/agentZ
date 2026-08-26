import type { Dashboard, DashboardWidgetKind, DashboardWidgetWidth } from "@/lib/gateway/client"
import { Skeleton } from "@/components/ui/skeleton"

export const dashboardWidgetWidthClasses = {
  full: "col-span-12",
  half: "col-span-12 lg:col-span-6",
  third: "col-span-12 md:col-span-6 xl:col-span-4",
} satisfies Record<DashboardWidgetWidth, string>

export function DashboardSkeleton({ dashboard }: { dashboard?: Dashboard }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col" role="status">
      <span className="sr-only">Loading dashboard</span>
      <div className="bg-background flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-8 w-56" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="size-7" />
        </div>
      </div>
      <div className="bg-muted/45 grid grid-cols-12 gap-2 p-2">
        {dashboard ? (
          dashboard.widgets.map((widget) => (
            <DashboardWidgetSkeleton
              columnCount={widget.columns.length}
              key={widget.name}
              kind={widget.kind}
              title={widget.title}
              width={widget.width}
            />
          ))
        ) : (
          <>
            <DashboardWidgetSkeleton kind="line" width="half" />
            <DashboardWidgetSkeleton kind="gauge" width="half" />
            <DashboardWidgetSkeleton columnCount={4} kind="table" width="full" />
          </>
        )}
      </div>
    </div>
  )
}

function DashboardWidgetSkeleton({
  columnCount,
  kind,
  title,
  width,
}: {
  columnCount?: number
  kind: DashboardWidgetKind
  title?: string
  width: DashboardWidgetWidth
}) {
  return (
    <section
      className={`bg-background h-80 min-w-0 overflow-hidden rounded-sm border ${dashboardWidgetWidthClasses[width]}`}
    >
      <header className="flex h-11 items-center border-b px-4">
        {title ? (
          <h2 className="truncate text-sm font-semibold">{title}</h2>
        ) : (
          <Skeleton className="h-4 w-32" />
        )}
      </header>
      <div className="h-[calc(20rem-2.75rem)]">
        {kind === "table" ? (
          <DashboardTableSkeleton columnCount={columnCount ?? 4} />
        ) : (
          <div className="h-full p-3">
            <DashboardWidgetBodySkeleton />
          </div>
        )}
      </div>
    </section>
  )
}

export function DashboardWidgetBodySkeleton() {
  return (
    <div aria-hidden="true" className="flex h-full flex-col gap-3">
      <div className="border-border/60 relative min-h-0 flex-1 overflow-hidden border-b border-l">
        <div className="border-border/45 absolute inset-x-0 top-1/4 border-t" />
        <div className="border-border/45 absolute inset-x-0 top-1/2 border-t" />
        <div className="border-border/45 absolute inset-x-0 top-3/4 border-t" />
        <svg
          className="text-muted absolute inset-0 h-full w-full animate-pulse"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <path
            d="M0 82 C12 78 15 55 27 60 S43 72 53 46 S67 22 77 39 S90 31 100 16 L100 100 L0 100 Z"
            fill="currentColor"
            fillOpacity="0.35"
          />
          <path
            d="M0 82 C12 78 15 55 27 60 S43 72 53 46 S67 22 77 39 S90 31 100 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="flex justify-center gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  )
}

export function DashboardTableSkeleton({ columnCount }: { columnCount: number }) {
  return (
    <div aria-hidden="true" className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 border-b">
        {Array.from({ length: columnCount }, (_, column) => (
          <div className="flex min-w-32 flex-1 items-center px-4" key={column}>
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: 5 }, (_, row) => (
          <div className="flex h-9 border-b" key={row}>
            {Array.from({ length: columnCount }, (_, column) => (
              <div className="flex min-w-32 flex-1 items-center px-4" key={column}>
                <Skeleton className={column % 2 === 0 ? "h-3 w-24" : "h-3 w-16"} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-end gap-2 px-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  )
}
