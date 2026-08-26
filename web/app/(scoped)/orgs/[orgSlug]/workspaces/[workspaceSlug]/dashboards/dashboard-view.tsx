"use client"

import * as React from "react"
import { useProgress } from "@bprogress/next"
import type { Route } from "next"
import dynamic from "next/dynamic"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  keepPreviousData,
  queryOptions,
  useIsFetching,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  type ColumnDef,
  getCoreRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  BotIcon,
  ChartArea,
  ChartBar,
  ChartNoAxesCombined,
  ChartPie,
  ChartSpline,
  Funnel as FunnelIcon,
  Gauge,
  LayoutDashboard,
  RefreshCw,
  ScatterChart,
  Table2,
  Workflow,
  type LucideIcon,
} from "lucide-react"
import {
  listDashboardTableRows,
  queryDashboard,
  type Dashboard,
  type DashboardSummary,
  type DashboardTableRow,
  type DashboardWidget,
  type DashboardWidgetKind,
  type DashboardWidgetQueryResult,
  type QueryDashboardResponse,
} from "@/lib/gateway/client"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TablePagination } from "@/components/table-pagination"
import { Button } from "@/components/ui/button"
import { DateRangePicker } from "@/components/ui/calendar"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyValue, RelativeDateTime } from "@/components/ui/table"
import { dayjs } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  DashboardTableSkeleton,
  DashboardWidgetBodySkeleton,
  dashboardWidgetWidthClasses,
} from "./dashboard-skeleton"

const DashboardChart = dynamic(
  () => import("./dashboard-chart").then((module) => module.DashboardChart),
  {
    loading: () => <DashboardWidgetBodySkeleton />,
    ssr: false,
  }
)

const widgetIcons = {
  area: ChartArea,
  bar: ChartBar,
  funnel: FunnelIcon,
  gauge: Gauge,
  horizontal_funnel: FunnelIcon,
  horizontal_grouped_bar: ChartBar,
  line: ChartSpline,
  pie: ChartPie,
  sankey: Workflow,
  scatter: ScatterChart,
  step: ChartNoAxesCombined,
  table: Table2,
} satisfies Record<DashboardWidgetKind, LucideIcon>

export function DashboardView({
  dashboard,
  dashboards,
  from,
  initialData,
  to,
  workspaceId,
  workspacePath,
}: {
  dashboard: Dashboard
  dashboards: DashboardSummary[]
  from: string
  initialData?: QueryDashboardResponse
  to: string
  workspaceId: string
  workspacePath: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [navigationPending, startNavigation] = React.useTransition()
  const progress = useProgress()
  const queryClient = useQueryClient()
  const dashboardQueryKey = [
    "dashboard",
    workspaceId,
    dashboard.agent_name,
    dashboard.name,
    from,
    to,
  ] as const
  const fetchingCount = useIsFetching({ queryKey: dashboardQueryKey })

  React.useEffect(() => {
    if (navigationPending) {
      progress.start(undefined, 100)
      return
    }

    progress.stop()
  }, [navigationPending, progress])

  const widgetsQuery = useQuery(
    queryOptions({
      queryKey: [
        "dashboard",
        workspaceId,
        dashboard.agent_name,
        dashboard.name,
        from,
        to,
        "widgets",
      ],
      queryFn: async ({ signal }) => {
        const { data, error } = await queryDashboard({
          signal,
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: { agentName: dashboard.agent_name, dashboardName: dashboard.name },
          body: { from, to, max_points: 240 },
        })
        if (error) throw new Error(error.message)
        return data
      },
      initialData,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })
  )

  function updateLocation(next: {
    agentName?: string
    dashboardName?: string
    from?: string
    to?: string
  }) {
    const params = new URLSearchParams(searchParams)
    params.set("agent_name", next.agentName ?? dashboard.agent_name)
    params.set("dashboard_name", next.dashboardName ?? dashboard.name)
    if (next.from) params.set("from", next.from)
    if (next.to) params.set("to", next.to)
    startNavigation(() => {
      router.replace(`${pathname}?${params.toString()}` as Route)
    })
  }

  const agents = [...new Set(dashboards.map((item) => item.agent_name))]
  const agentDashboards = dashboards.filter((item) => item.agent_name === dashboard.agent_name)
  const results = new Map(widgetsQuery.data?.widgets.map((widget) => [widget.widget_name, widget]))

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="bg-background flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
        <Select
          disabled={navigationPending}
          value={dashboard.agent_name}
          onValueChange={(agentName) => {
            const first = dashboards.find((item) => item.agent_name === agentName)
            if (!first) return
            updateLocation({ agentName, dashboardName: first.name })
          }}
        >
          <SelectTrigger className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agents.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  <BotIcon className="inline-block" />
                  {agent}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          disabled={navigationPending}
          value={dashboard.name}
          onValueChange={(dashboardName) => updateLocation({ dashboardName })}
        >
          <SelectTrigger className="h-8 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agentDashboards.map((item) => (
                <SelectItem key={item.name} value={item.name}>
                  <LayoutDashboard className="inline-block" />
                  {item.title}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DateRangePicker
            disabled={navigationPending}
            onSelect={(nextRange) => {
              const nextFrom = dayjs(nextRange.from).toISOString()
              const nextTo = dayjs(nextRange.to).toISOString()
              updateLocation({ from: nextFrom, to: nextTo })
            }}
            range={{ from: dayjs(from).toDate(), to: dayjs(to).toDate() }}
          />
          <Button
            aria-label="Refresh dashboard"
            disabled={navigationPending || fetchingCount > 0}
            onClick={() =>
              void queryClient.refetchQueries({ queryKey: dashboardQueryKey, type: "active" })
            }
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw className={cn(fetchingCount > 0 && "animate-spin")} />
          </Button>
        </div>
      </div>
      {widgetsQuery.error ? (
        <div className="text-destructive border-b px-6 py-3 text-sm">
          {widgetsQuery.error.message}
        </div>
      ) : null}
      <div className="bg-muted/30 grid grid-cols-12 gap-2 p-2">
        {dashboard.widgets.map((widget) => (
          <Widget
            key={widget.name}
            dashboard={dashboard}
            from={from}
            pending={widgetsQuery.isPending}
            result={results.get(widget.name)}
            to={to}
            widget={widget}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
          />
        ))}
      </div>
    </div>
  )
}

function Widget({
  dashboard,
  from,
  pending,
  result,
  to,
  widget,
  workspaceId,
  workspacePath,
}: {
  dashboard: Dashboard
  from: string
  pending: boolean
  result?: DashboardWidgetQueryResult
  to: string
  widget: DashboardWidget
  workspaceId: string
  workspacePath: string
}) {
  const Icon = widgetIcons[widget.kind]

  return (
    <section
      aria-busy={pending}
      className={cn(
        "bg-card h-80 min-w-0 overflow-hidden rounded-lg border shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_5%,transparent)] transition-shadow duration-200 [content-visibility:auto] hover:shadow-[0_8px_24px_color-mix(in_oklab,var(--foreground)_8%,transparent)]",
        dashboardWidgetWidthClasses[widget.width]
      )}
    >
      <header className="from-card to-muted/20 flex h-12 items-center gap-2.5 border-b bg-gradient-to-r px-3.5">
        <span className="bg-primary/8 text-primary ring-primary/10 flex size-7 shrink-0 items-center justify-center rounded-md ring-1">
          <Icon className="size-3.5" strokeWidth={2.25} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
          {widget.title}
        </h2>
      </header>
      <div className={cn("h-[calc(20rem-3rem)] min-w-0", widget.kind !== "table" && "p-3")}>
        {widget.kind === "table" ? (
          <DashboardTable
            key={widget.data_revision}
            dashboard={dashboard}
            from={from}
            to={to}
            widget={widget}
            workspaceId={workspaceId}
            workspacePath={workspacePath}
          />
        ) : result?.status === "invalid_data" ? (
          <InvalidWidget
            agentName={dashboard.agent_name}
            message={result.error?.message}
            workspacePath={workspacePath}
          />
        ) : pending ? (
          <DashboardWidgetBodySkeleton />
        ) : !result || result.status === "empty" ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            No data
          </div>
        ) : (
          <DashboardChart widget={widget} result={result} />
        )}
      </div>
    </section>
  )
}

function InvalidWidget({
  agentName,
  message,
  workspacePath,
}: {
  agentName: string
  message?: string
  workspacePath: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium">This widget’s stored data is invalid.</p>
      <p className="text-muted-foreground text-xs">{message}</p>
      <Button asChild size="sm" variant="outline">
        <Link
          href={`${workspacePath}/sessions/new?agent=${encodeURIComponent(agentName)}` as Route}
        >
          Ask agent to fix
        </Link>
      </Button>
    </div>
  )
}

function DashboardTable({
  dashboard,
  from,
  to,
  widget,
  workspaceId,
  workspacePath,
}: {
  dashboard: Dashboard
  from: string
  to: string
  widget: DashboardWidget
  workspaceId: string
  workspacePath: string
}) {
  "use no memo"

  const [pageToken, setPageToken] = React.useState<string>()
  const [history, setHistory] = React.useState<(string | undefined)[]>([])
  const [sorting, setSorting] = React.useState<SortingState>([])
  const query = useQuery(
    queryOptions({
      queryKey: [
        "dashboard",
        workspaceId,
        dashboard.agent_name,
        dashboard.name,
        from,
        to,
        "table",
        widget.name,
        widget.data_revision,
        sorting,
        pageToken,
      ],
      queryFn: async ({ signal }) => {
        const { data, error } = await listDashboardTableRows({
          signal,
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: {
            agentName: dashboard.agent_name,
            dashboardName: dashboard.name,
            widgetName: widget.name,
          },
          query: {
            event_time_after: from,
            event_time_before: to,
            page_token: pageToken,
            sort: sorting.map(({ desc, id }) => `${id}:${desc ? "desc" : "asc"}`),
          },
        })
        if (error) throw new Error(error.message)
        return data
      },
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      placeholderData: keepPreviousData,
    })
  )

  const columns = React.useMemo<ColumnDef<DashboardTableRow>[]>(
    () =>
      widget.columns.map((column, index) => ({
        id: column.name,
        accessorFn: (row) => row.cells.at(index)?.[column.type],
        header: column.label,
        enableSorting: column.sortable,
        cell: ({ row }) => {
          switch (column.type) {
            case "text":
              return row.original.cells.at(index)?.text || <EmptyValue />
            case "number": {
              const value = row.original.cells.at(index)?.number
              return value === undefined ? <EmptyValue /> : value.toLocaleString()
            }
            case "boolean": {
              const value = row.original.cells.at(index)?.boolean
              return value === undefined ? <EmptyValue /> : value ? "True" : "False"
            }
            case "datetime": {
              const value = row.original.cells.at(index)?.datetime
              return value === undefined ? <EmptyValue /> : <RelativeDateTime value={value} />
            }
          }
        },
      })),
    [widget.columns]
  )
  const layout = React.useMemo<Record<string, AdminColumnLayout>>(
    () =>
      Object.fromEntries(
        widget.columns.map((column) => [
          column.name,
          {
            align: column.type === "number" ? "end" : undefined,
            minWidth: { boolean: 96, datetime: 176, number: 128, text: 160 }[column.type],
          },
        ])
      ),
    [widget.columns]
  )
  const rows = React.useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: rows,
    enableMultiSort: true,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    maxMultiSortColCount: 3,
    onSortingChange: (update) => {
      setSorting(update)
      setPageToken(undefined)
      setHistory([])
    },
    state: { sorting },
  })
  const data = query.data

  if (query.isPending) {
    return (
      <div className="h-full" role="status">
        <span className="sr-only">Loading {widget.title}</span>
        <DashboardTableSkeleton columnCount={widget.columns.length} />
      </div>
    )
  }

  if (data?.status === "invalid_data")
    return (
      <InvalidWidget
        agentName={dashboard.agent_name}
        message={data.error?.message}
        workspacePath={workspacePath}
      />
    )

  return (
    <AdminDataGrid
      ariaLabel={widget.title}
      className="h-full gap-0 [&_[data-slot=table-head]]:h-8 [&_[data-slot=table-head]]:px-4 [&>nav]:h-14 [&>nav]:shrink-0"
      emptyState={
        <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
          {query.error ? (
            <span className="text-destructive">{query.error.message}</span>
          ) : (
            (data?.error?.message ?? "No data")
          )}
        </div>
      }
      layout={layout}
      pagination={
        data ? (
          <TablePagination
            canGoNext={data.next_page_token !== ""}
            canGoPrevious={history.length > 0}
            goNext={() => {
              setHistory((items) => [...items, pageToken])
              setPageToken(data.next_page_token)
            }}
            goPrevious={() => {
              setPageToken(history.at(-1))
              setHistory((items) => items.slice(0, -1))
            }}
            pending={query.isFetching}
          />
        ) : null
      }
      rows={rows}
      table={table}
      viewportClassName="min-h-0 flex-1 overflow-y-auto"
    />
  )
}
