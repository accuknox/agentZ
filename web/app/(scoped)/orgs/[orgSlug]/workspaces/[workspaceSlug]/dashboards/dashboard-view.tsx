"use client"

import * as React from "react"
import type { Route } from "next"
import dynamic from "next/dynamic"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query"
import {
  type ColumnDef,
  getCoreRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { BotIcon, LayoutDashboard, RefreshCw } from "lucide-react"
import {
  listDashboardTableRows,
  queryDashboard,
  type Dashboard,
  type DashboardSummary,
  type DashboardTableRow,
  type DashboardWidget,
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

export function DashboardView({
  dashboard,
  dashboards,
  initialData,
  initialFrom,
  initialTo,
  workspaceId,
  workspacePath,
}: {
  dashboard: Dashboard
  dashboards: DashboardSummary[]
  initialData?: QueryDashboardResponse
  initialFrom: string
  initialTo: string
  workspaceId: string
  workspacePath: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [from, setFrom] = React.useState(initialFrom)
  const [to, setTo] = React.useState(initialTo)

  const query = useQuery(
    queryOptions({
      queryKey: ["dashboard", workspaceId, dashboard.agent_name, dashboard.name, from, to],
      queryFn: async () => {
        const { data, error } = await queryDashboard({
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
    if (next.agentName) params.set("agent_name", next.agentName)
    if (next.dashboardName) params.set("dashboard_name", next.dashboardName)
    if (next.from) params.set("from", next.from)
    if (next.to) params.set("to", next.to)
    router.replace(`${pathname}?${params.toString()}` as Route)
  }

  const agents = [...new Set(dashboards.map((item) => item.agent_name))]
  const agentDashboards = dashboards.filter((item) => item.agent_name === dashboard.agent_name)
  const results = new Map(query.data?.widgets.map((widget) => [widget.widget_name, widget]))

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="bg-background flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
        <Select
          value={dashboard.agent_name}
          onValueChange={(agentName) => {
            const first = dashboards.find((item) => item.agent_name === agentName)
            updateLocation({ agentName, dashboardName: first?.name })
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
            onSelect={(nextRange) => {
              const nextFrom = dayjs(nextRange.from).toISOString()
              const nextTo = dayjs(nextRange.to).toISOString()
              setFrom(nextFrom)
              setTo(nextTo)
              updateLocation({ from: nextFrom, to: nextTo })
            }}
            range={{ from: dayjs(from).toDate(), to: dayjs(to).toDate() }}
          />
          <Button
            aria-label="Refresh dashboard"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw className={cn(query.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>
      {query.error ? (
        <div className="text-destructive border-b px-6 py-3 text-sm">{query.error.message}</div>
      ) : null}
      <div className="bg-muted/45 grid grid-cols-12 gap-2 p-2">
        {dashboard.widgets.map((widget) => (
          <Widget
            key={widget.name}
            dashboard={dashboard}
            from={from}
            pending={query.isPending}
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
  const [seen, setSeen] = React.useState(false)
  const sectionRef = React.useRef<HTMLElement>(null)

  React.useEffect(() => {
    const section = sectionRef.current
    if (!section) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          // Keep charts mounted after first paint so revisiting them does not
          // move Recharts initialization work back onto the scroll path.
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin: "256px 0px" }
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  return (
    <section
      aria-busy={pending}
      className={cn(
        "bg-background h-80 min-w-0 overflow-hidden rounded-sm border [content-visibility:auto]",
        dashboardWidgetWidthClasses[widget.width]
      )}
      ref={sectionRef}
    >
      <header className="flex h-11 items-center border-b px-4">
        <h2 className="truncate text-sm font-semibold">{widget.title}</h2>
      </header>
      <div className={cn("h-[calc(20rem-2.75rem)] min-w-0", widget.kind !== "table" && "p-3")}>
        {widget.kind === "table" ? (
          <DashboardTable
            key={`${widget.data_revision}:${from}:${to}`}
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
        ) : seen ? (
          <DashboardChart widget={widget} result={result} />
        ) : (
          <DashboardWidgetBodySkeleton />
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
        "dashboard-table",
        workspaceId,
        dashboard.agent_name,
        dashboard.name,
        widget.name,
        widget.data_revision,
        from,
        to,
        sorting,
        pageToken,
      ],
      queryFn: async () => {
        const { data, error } = await listDashboardTableRows({
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
