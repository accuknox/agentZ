"use client"

import * as React from "react"
import type { Route } from "next"
import dynamic from "next/dynamic"
import { useRouter } from "@bprogress/next/app"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { CalendarDays, LayoutDashboard, ListFilter, RefreshCw } from "lucide-react"
import type { DateRange } from "react-day-picker"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { dayjs } from "@/lib/format"
import {
  listDashboardFilterOptions,
  queryDashboardWidget,
  type Dashboard,
  type DashboardFilter,
  type DashboardQueryRequest,
  type DashboardSummary,
  type DashboardTimeRange,
  type DashboardWidget,
  type DashboardWidgetResult,
} from "@/lib/gateway/client"
import { cn } from "@/lib/utils"

const DashboardChart = dynamic(
  () => import("./dashboard-chart").then((module) => module.DashboardChart),
  {
    loading: () => <Skeleton className="h-64 w-full" />,
    ssr: false,
  }
)

const defaultDashboardDuration = 24 * 60 * 60 * 1000

type DashboardRange =
  | { duration: number; from: Date; kind: "live"; to: Date }
  | { from: Date; kind: "fixed"; selectedTo: Date; to: Date }

type DashboardContextValue = {
  dashboard: Dashboard
  liveDuration?: number
  observeVisibility: (element: HTMLElement, listener: (visible: boolean) => void) => () => void
  request: DashboardQueryRequest
  workspaceId: string
}

const DashboardContext = React.createContext<DashboardContextValue | null>(null)

export function DashboardView({
  children,
  dashboard,
  workspaceId,
}: {
  children: React.ReactNode
  dashboard: Dashboard
  workspaceId: string
}) {
  const [range, setRange] = React.useState<DashboardRange>(() => {
    const to = dayjs()
    return {
      duration: defaultDashboardDuration,
      from: to.subtract(24, "hour").toDate(),
      kind: "live",
      to: to.toDate(),
    }
  })
  const [filters, setFilters] = React.useState<Record<string, string[]>>({})
  const observerRef = React.useRef<IntersectionObserver | null>(null)
  const visibilityListenersRef = React.useRef(new Map<Element, (visible: boolean) => void>())
  const queryClient = useQueryClient()
  const liveDuration = range.kind === "live" ? range.duration : undefined
  const observeVisibility = React.useCallback(
    (element: HTMLElement, listener: (visible: boolean) => void) => {
      let observer = observerRef.current
      if (!observer) {
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              visibilityListenersRef.current.get(entry.target)?.(entry.isIntersecting)
            }
          },
          { rootMargin: "256px 0px" }
        )
        observerRef.current = observer
      }
      visibilityListenersRef.current.set(element, listener)
      observer.observe(element)

      return () => {
        observer.unobserve(element)
        visibilityListenersRef.current.delete(element)
      }
    },
    []
  )
  const request = React.useMemo<DashboardQueryRequest>(() => {
    return {
      time_range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      filters: dashboard.definition.filters.flatMap((filter) => {
        const values = filters[filter.id] ?? []
        return values.length > 0 ? [{ filter_id: filter.id, values }] : []
      }),
    }
  }, [dashboard.definition.filters, filters, range])

  React.useEffect(() => {
    const visibilityListeners = visibilityListenersRef.current
    return () => {
      observerRef.current?.disconnect()
      visibilityListeners.clear()
    }
  }, [])

  return (
    <DashboardContext.Provider
      value={{ dashboard, liveDuration, observeVisibility, request, workspaceId }}
    >
      <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 md:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <DashboardDateRange range={range} onRangeChange={setRange} />
          {dashboard.definition.filters.map((filter) => (
            <DashboardFilterSelect
              dashboardId={dashboard.id}
              filter={filter}
              key={filter.id}
              liveDuration={liveDuration}
              onValueChange={(values) =>
                setFilters((current) => ({ ...current, [filter.id]: values }))
              }
              timeRange={request.time_range}
              value={filters[filter.id] ?? []}
              workspaceId={workspaceId}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          {liveDuration ? (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
              <span aria-hidden="true" className="bg-primary size-1.5 rounded-full" />
              Live · 30s
            </span>
          ) : null}
          <Button
            onClick={() =>
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  query.meta?.workspaceId === workspaceId &&
                  query.meta.dashboardId === dashboard.id,
              })
            }
            size="sm"
            variant="ghost"
          >
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-x-10 gap-y-6">{children}</div>
    </DashboardContext.Provider>
  )
}

function DashboardFilterSelect({
  dashboardId,
  filter,
  liveDuration,
  onValueChange,
  timeRange,
  value,
  workspaceId,
}: {
  dashboardId: string
  filter: DashboardFilter
  liveDuration?: number
  onValueChange: (value: string[]) => void
  timeRange: DashboardTimeRange
  value: string[]
  workspaceId: string
}) {
  const [open, setOpen] = React.useState(false)
  const query = useQuery(
    queryOptions({
      queryKey: [
        "dashboard-filter-options",
        workspaceId,
        dashboardId,
        filter.id,
        timeRange,
        liveDuration,
      ],
      queryFn: async () => {
        const result = await listDashboardFilterOptions({
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: { dashboardId, filterId: filter.id },
          body: liveDuration ? recentTimeRange(liveDuration) : timeRange,
          throwOnError: false,
        })
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      enabled: open,
      meta: { dashboardId, workspaceId },
      refetchInterval: open && liveDuration ? 30_000 : false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    })
  )

  return (
    <MultiSelectDropdown
      className="w-48"
      emptyMessage={
        query.isPending
          ? "Loading values..."
          : query.isError
            ? "Could not load values."
            : "No values for this period"
      }
      onOpenChangeAction={setOpen}
      onValueChangeAction={(next) => onValueChange(filter.multiple ? next : next.slice(-1))}
      options={(query.data?.values ?? []).map((option) => ({
        icon: ListFilter,
        label: option,
        value: option,
      }))}
      placeholder={filter.label}
      searchPlaceholder={`Search ${filter.label.toLowerCase()}`}
      value={value}
    />
  )
}

export function DashboardPicker({
  dashboards,
  root,
  selectedId,
  workspaceId,
}: {
  dashboards: DashboardSummary[]
  root: string
  selectedId: string
  workspaceId: string
}) {
  const router = useRouter()
  const cookieName = `agentz-last-dashboard-${workspaceId}`

  React.useEffect(() => {
    document.cookie = `${cookieName}=${encodeURIComponent(selectedId)}; Path=/; Max-Age=31536000; SameSite=Lax`
  }, [cookieName, selectedId])

  return (
    <Select
      value={selectedId}
      onValueChange={(dashboardId) => {
        router.push(`${root}/${dashboardId}` as Route)
      }}
    >
      <SelectTrigger aria-label="Select dashboard" className="h-8 w-full sm:w-64">
        <SelectValue placeholder="Dashboard" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {dashboards.map((dashboard) => (
            <SelectItem key={dashboard.id} value={dashboard.id}>
              <LayoutDashboard aria-hidden="true" />
              {dashboard.title}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function DashboardDateRange({
  onRangeChange,
  range,
}: {
  onRangeChange: (range: DashboardRange) => void
  range: DashboardRange
}) {
  const [draft, setDraft] = React.useState<DateRange | undefined>({
    from: range.from,
    to: range.to,
  })
  const label =
    range.kind === "live"
      ? "Last 24 hours"
      : `${dayjs(range.from).format("MMM D, YYYY")} - ${dayjs(range.selectedTo).format("MMM D, YYYY")}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className="h-8 w-full max-w-full justify-start rounded-md font-normal sm:w-auto"
          variant="outline"
        >
          <CalendarDays data-icon="inline-start" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-fit p-0">
        <Calendar
          disabled={[
            { after: new Date() },
            { before: dayjs().startOf("day").subtract(29, "day").toDate() },
          ]}
          mode="range"
          numberOfMonths={2}
          onSelect={(selected) => {
            setDraft(selected)
            if (!selected?.from || !selected.to) return

            const to = dayjs(selected.to).isSame(dayjs(), "day")
              ? new Date()
              : dayjs(selected.to).add(1, "day").startOf("day").toDate()
            onRangeChange({
              from: dayjs(selected.from).startOf("day").toDate(),
              kind: "fixed",
              selectedTo: selected.to,
              to,
            })
          }}
          resetOnSelect
          selected={draft}
        />
        <div className="border-t p-2">
          <Button
            className="w-full justify-start"
            onClick={() => {
              const to = dayjs()
              const next: DashboardRange = {
                duration: defaultDashboardDuration,
                from: to.subtract(24, "hour").toDate(),
                kind: "live",
                to: to.toDate(),
              }
              setDraft({ from: next.from, to: next.to })
              onRangeChange(next)
            }}
            size="sm"
            variant="ghost"
          >
            <CalendarDays data-icon="inline-start" />
            Last 24 hours
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DashboardWidgetView({
  initialData,
  widget,
}: {
  initialData: DashboardWidgetResult
  widget: DashboardWidget
}) {
  const context = React.useContext(DashboardContext)
  if (!context) throw new Error("DashboardWidgetView must be rendered inside DashboardView")
  const { dashboard, liveDuration, observeVisibility, request, workspaceId } = context
  const [visible, setVisible] = React.useState(false)
  const [initialRequest] = React.useState(request)
  const sectionRef = React.useRef<HTMLElement>(null)
  const query = useQuery(
    queryOptions({
      queryKey: [
        "dashboard-widget",
        workspaceId,
        dashboard.id,
        widget.id,
        request,
        liveDuration,
      ] as const,
      queryFn: async () => {
        const result = await queryDashboardWidget({
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: { dashboardId: dashboard.id, widgetId: widget.id },
          body: {
            ...request,
            time_range: liveDuration ? recentTimeRange(liveDuration) : request.time_range,
          },
          throwOnError: false,
        })
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      enabled: visible,
      initialData: request === initialRequest ? initialData : undefined,
      meta: { dashboardId: dashboard.id, workspaceId },
      placeholderData: (previous) => previous,
      refetchInterval: visible && liveDuration ? 30_000 : false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
      retry: 2,
      staleTime: 30_000,
    })
  )

  React.useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    return observeVisibility(section, setVisible)
  }, [observeVisibility])

  const width =
    widget.width === "full"
      ? "col-span-12"
      : widget.width === "half"
        ? "col-span-12 lg:col-span-6"
        : "col-span-12 md:col-span-6 xl:col-span-4"

  return (
    <section aria-busy={query.isFetching} className={cn(width, "min-w-0 py-2")} ref={sectionRef}>
      <header className="mb-2 flex flex-col gap-1 px-4 md:px-6">
        <h2 className="text-sm font-semibold">{widget.title}</h2>
        {widget.description ? (
          <p className="text-muted-foreground text-xs">{widget.description}</p>
        ) : null}
      </header>
      {query.isPending ? (
        <Skeleton className="h-52 w-full" />
      ) : query.isError ? (
        <div className="text-destructive flex h-52 items-center justify-center text-sm">
          Could not load this widget.
        </div>
      ) : (
        <WidgetContent
          data={query.data}
          unit={
            dashboard.definition.measures.find((measure) => measure.name === widget.measure)?.unit
          }
          visible={visible}
          widget={widget}
        />
      )}
    </section>
  )
}

function WidgetContent({
  data,
  unit,
  visible,
  widget,
}: {
  data: DashboardWidgetResult
  unit?: string
  visible: boolean
  widget: DashboardWidget
}) {
  if (widget.kind === "metric") {
    return (
      <div className="flex min-h-16 items-end px-4 pb-2 md:px-6">
        <p className="font-heading text-4xl font-semibold tracking-tight tabular-nums">
          {new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(data.total ?? 0)}
          {unit ? (
            <span className="text-muted-foreground ml-2 text-base font-normal">{unit}</span>
          ) : null}
        </p>
      </div>
    )
  }
  if (widget.kind === "table") {
    return <DashboardTable data={data} title={widget.title} />
  }
  if (!visible) return <Skeleton className="h-64 w-full" />
  return <DashboardChart data={data} kind={widget.kind} stacked={widget.stacked} />
}

function DashboardTable({ data, title }: { data: DashboardWidgetResult; title: string }) {
  "use no memo"

  const { columns, layout } = React.useMemo(() => {
    const layout: Record<string, AdminColumnLayout> = {}
    const columns: ColumnDef<DashboardWidgetResult["rows"][number]>[] = data.columns.map(
      (header, index) => {
        const id = `column-${index}`
        layout[id] = { minWidth: 144 }
        return {
          id,
          header,
          cell: ({ row }) => row.original.cells[index],
        }
      }
    )
    return { columns, layout }
  }, [data.columns])
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ data: data.rows, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <AdminDataGrid
      ariaLabel={title}
      emptyState={<p className="text-muted-foreground py-8 text-center">No rows to display.</p>}
      layout={layout}
      rows={data.rows}
      table={table}
    />
  )
}

function recentTimeRange(duration: number): DashboardTimeRange {
  const to = dayjs()
  return {
    from: to.subtract(duration, "millisecond").toISOString(),
    to: to.toISOString(),
  }
}
