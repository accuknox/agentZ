"use client"

import * as React from "react"
import type { Route } from "next"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  listDashboardTableRows,
  queryDashboard,
  type Dashboard,
  type DashboardCell,
  type DashboardSummary,
  type DashboardTableColumn,
  type DashboardWidget,
  type DashboardWidgetQueryResult,
  type QueryDashboardResponse,
} from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

const palette = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const ranges = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const

type RangeName = keyof typeof ranges | "custom"

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
  const [range, setRange] = React.useState<RangeName>("24h")
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

  function chooseRange(next: RangeName) {
    setRange(next)
    if (next === "custom") return
    const nextTo = new Date().toISOString()
    const nextFrom = new Date(Date.parse(nextTo) - ranges[next]).toISOString()
    setFrom(nextFrom)
    setTo(nextTo)
    updateLocation({ from: nextFrom, to: nextTo })
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
            {agents.map((agent) => (
              <SelectItem key={agent} value={agent}>
                {agent}
              </SelectItem>
            ))}
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
            {agentDashboards.map((item) => (
              <SelectItem key={item.name} value={item.name}>
                {item.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={range} onValueChange={(value) => chooseRange(value as RangeName)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last hour</SelectItem>
              <SelectItem value="6h">Last 6h</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7d</SelectItem>
              <SelectItem value="30d">Last 30d</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          {range === "custom" ? (
            <>
              <Input
                aria-label="From"
                className="h-8 w-48"
                type="datetime-local"
                value={from.slice(0, 16)}
                onChange={(event) => {
                  if (event.target.value) setFrom(new Date(event.target.value).toISOString())
                }}
              />
              <Input
                aria-label="To"
                className="h-8 w-48"
                type="datetime-local"
                value={to.slice(0, 16)}
                onChange={(event) => {
                  if (!event.target.value) return
                  const nextTo = new Date(event.target.value).toISOString()
                  setTo(nextTo)
                  updateLocation({ from, to: nextTo })
                }}
              />
            </>
          ) : null}
          <Button
            aria-label="Refresh dashboard"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            size="icon-sm"
            variant="outline"
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
  result,
  to,
  widget,
  workspaceId,
  workspacePath,
}: {
  dashboard: Dashboard
  from: string
  result?: DashboardWidgetQueryResult
  to: string
  widget: DashboardWidget
  workspaceId: string
  workspacePath: string
}) {
  const width =
    widget.width === "full"
      ? "col-span-12"
      : widget.width === "half"
        ? "col-span-12 lg:col-span-6"
        : "col-span-12 md:col-span-6 xl:col-span-4"
  return (
    <section className={cn("bg-background h-80 min-w-0 overflow-hidden rounded-sm border", width)}>
      <header className="flex h-11 items-center border-b px-4">
        <h2 className="truncate text-sm font-semibold">{widget.title}</h2>
      </header>
      <div className="h-[calc(20rem-2.75rem)] min-w-0 p-3">
        {widget.kind === "table" ? (
          <DashboardTable
            key={`${from}:${to}`}
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
        ) : !result || result.status === "empty" ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            No data
          </div>
        ) : (
          <Chart widget={widget} result={result} />
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

function Chart({
  widget,
  result,
}: {
  widget: DashboardWidget
  result: DashboardWidgetQueryResult
}) {
  const config = Object.fromEntries(
    widget.series.map((series, index) => [
      `s${index}`,
      { label: series.label, color: palette[index] },
    ])
  ) satisfies ChartConfig
  if (widget.kind === "line" || widget.kind === "step" || widget.kind === "area") {
    const data = result.points.map((point) =>
      Object.assign(
        { at: new Date(point.at).toLocaleString() },
        Object.fromEntries(point.values.map((value, index) => [`s${index}`, value]))
      )
    )
    if (widget.kind === "area") {
      return (
        <ChartContainer className="h-full w-full" config={config}>
          <AreaChart data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="at" minTickGap={28} />
            <YAxis width={40} />
            <ChartTooltip />
            {widget.series.map((_, index) => (
              <Area
                key={index}
                dataKey={`s${index}`}
                fill={`var(--color-s${index})`}
                fillOpacity={0.14}
                stroke={`var(--color-s${index})`}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )
    }
    return (
      <ChartContainer className="h-full w-full" config={config}>
        <LineChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="at" minTickGap={28} />
          <YAxis width={40} />
          <ChartTooltip />
          {widget.series.map((_, index) => (
            <Line
              key={index}
              dataKey={`s${index}`}
              dot={false}
              stroke={`var(--color-s${index})`}
              strokeWidth={2}
              type={widget.kind === "step" ? "stepAfter" : "monotone"}
            />
          ))}
        </LineChart>
      </ChartContainer>
    )
  }
  if (widget.kind === "pie") {
    const data = result.categories.map((category) => ({
      name: category.label,
      value: category.values[0],
    }))
    return (
      <ChartContainer className="h-full w-full" config={config}>
        <PieChart>
          <ChartTooltip />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={92}>
            {data.map((item, index) => (
              <Cell key={item.name} fill={palette[index % palette.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    )
  }
  if (widget.kind === "bar" || widget.kind === "horizontal_grouped_bar") {
    const data = result.categories.map((category) =>
      Object.assign(
        { category: category.label },
        Object.fromEntries(category.values.map((value, index) => [`s${index}`, value]))
      )
    )
    const horizontal = widget.kind === "horizontal_grouped_bar"
    return (
      <ChartContainer className="h-full w-full" config={config}>
        <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"}>
          <CartesianGrid horizontal={!horizontal} vertical={horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" />
              <YAxis dataKey="category" type="category" width={86} />
            </>
          ) : (
            <>
              <XAxis dataKey="category" />
              <YAxis width={40} />
            </>
          )}
          <ChartTooltip />
          {widget.series.map((_, index) => (
            <Bar key={index} dataKey={`s${index}`} fill={`var(--color-s${index})`} radius={2} />
          ))}
        </BarChart>
      </ChartContainer>
    )
  }
  if (widget.kind === "scatter") {
    return (
      <ChartContainer className="h-full w-full" config={config}>
        <ScatterChart>
          <CartesianGrid />
          <XAxis dataKey="x" type="number" />
          <YAxis dataKey="y" type="number" width={40} />
          <ChartTooltip />
          {widget.series.map((_, index) => (
            <Scatter
              key={index}
              data={result.scatter.filter((point) => point.series === index)}
              fill={`var(--color-s${index})`}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
    )
  }
  const minimum = widget.minimum ?? 0
  const maximum = widget.maximum ?? 100
  const value = result.value ?? minimum
  const percent = Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100))
  const tone = widget.thresholds.findLast((threshold) => value >= threshold.value)?.tone
  const fill =
    tone === "critical" ? "var(--destructive)" : tone === "warning" ? "var(--warning)" : palette[0]
  return (
    <div className="relative h-full">
      <ChartContainer className="h-full w-full" config={config}>
        <RadialBarChart
          data={[{ value: percent, fill }]}
          innerRadius="72%"
          outerRadius="100%"
          startAngle={210}
          endAngle={-30}
        >
          <PolarAngleAxis angleAxisId={0} domain={[0, 100]} tick={false} type="number" />
          <RadialBar dataKey="value" background cornerRadius={4} />
        </RadialBarChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-8 text-3xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
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
  const [pageToken, setPageToken] = React.useState<string>()
  const [history, setHistory] = React.useState<string[]>([])
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
          query: { event_time_after: from, event_time_before: to, page_token: pageToken },
        })
        if (error) throw new Error(error.message)
        return data
      },
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    })
  )
  if (query.data?.status === "invalid_data")
    return (
      <InvalidWidget
        agentName={dashboard.agent_name}
        message={query.data.error?.message}
        workspacePath={workspacePath}
      />
    )
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {widget.columns.map((column) => (
                <TableHead key={column.name}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data?.rows.map((row, rowIndex) => (
              <TableRow key={`${row.received_at}-${rowIndex}`}>
                {widget.columns.map((column, index) => {
                  const cell = row.cells.at(index)
                  return (
                    <TableCell key={column.name}>{cell ? formatCell(column, cell) : "—"}</TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex h-9 items-end justify-end gap-1">
        <Button
          disabled={history.length === 0}
          onClick={() => {
            const next = [...history]
            setPageToken(next.pop())
            setHistory(next)
          }}
          size="sm"
          variant="ghost"
        >
          Previous
        </Button>
        <Button
          disabled={!query.data?.next_page_token}
          onClick={() => {
            setHistory((items) => [...items, pageToken ?? ""])
            setPageToken(query.data?.next_page_token)
          }}
          size="sm"
          variant="ghost"
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function formatCell(column: DashboardTableColumn, cell: DashboardCell) {
  switch (column.type) {
    case "text":
      return cell.text
    case "number":
      return cell.number?.toLocaleString()
    case "boolean":
      return cell.boolean ? "True" : "False"
    case "datetime":
      return cell.datetime ? new Date(cell.datetime).toLocaleString() : ""
  }
}
