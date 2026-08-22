"use client"

import * as React from "react"
import { queryOptions, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { ListFilter, RefreshCw } from "lucide-react"
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
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  listDashboardFilterOptions,
  queryDashboardWidget,
  type Dashboard,
  type DashboardQueryRequest,
  type DashboardWidget,
  type DashboardWidgetResult,
} from "@/lib/gateway/client"

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const timeTickFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
})

type DashboardContextValue = {
  dashboard: Dashboard
  request: DashboardQueryRequest
  workspaceId: string
}

const DashboardContext = React.createContext<DashboardContextValue | null>(null)

const dashboardWidgetQueryOptions = (
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  request: DashboardQueryRequest,
  initialData?: DashboardWidgetResult
) =>
  queryOptions({
    queryKey: ["dashboard-widget", workspaceId, dashboardId, widgetId, request] as const,
    queryFn: async () => {
      const to = new Date()
      const duration = Date.parse(request.time_range.to) - Date.parse(request.time_range.from)
      const result = await queryDashboardWidget({
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { dashboardId, widgetId },
        body: {
          ...request,
          time_range: {
            from: new Date(to.getTime() - duration).toISOString(),
            to: to.toISOString(),
          },
        },
        throwOnError: false,
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    initialData,
    meta: { dashboardId, workspaceId },
    placeholderData: (previous) => previous,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 2,
    staleTime: 30_000,
  })

export function DashboardView({
  children,
  dashboard,
  workspaceId,
}: {
  children: React.ReactNode
  dashboard: Dashboard
  workspaceId: string
}) {
  const [period, setPeriod] = React.useState("24h")
  const [filters, setFilters] = React.useState<Record<string, string[]>>({})
  const queryClient = useQueryClient()
  const request = React.useMemo<DashboardQueryRequest>(() => {
    const duration =
      period === "1h"
        ? 60 * 60 * 1000
        : period === "7d"
          ? 7 * 24 * 60 * 60 * 1000
          : period === "30d"
            ? 30 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000
    const to = new Date()
    return {
      time_range: {
        from: new Date(to.getTime() - duration).toISOString(),
        to: to.toISOString(),
      },
      filters: dashboard.definition.filters.flatMap((filter) => {
        const values = filters[filter.id] ?? []
        return values.length > 0 ? [{ filter_id: filter.id, values }] : []
      }),
    }
  }, [dashboard.definition.filters, filters, period])
  const optionQueries = useQueries({
    queries: dashboard.definition.filters.map((filter) =>
      queryOptions({
        queryKey: [
          "dashboard-filter-options",
          workspaceId,
          dashboard.id,
          filter.id,
          request.time_range,
        ],
        queryFn: async () => {
          const result = await listDashboardFilterOptions({
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: { dashboardId: dashboard.id, filterId: filter.id },
            body: request.time_range,
            throwOnError: false,
          })
          if (result.error) throw new Error(result.error.message)
          return result.data
        },
        staleTime: 30_000,
      })
    ),
  })

  return (
    <DashboardContext.Provider value={{ dashboard, request, workspaceId }}>
      <div className="bg-muted/20 border-y px-4 py-3 md:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger aria-label="Dashboard time range" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Last hour</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
            {dashboard.definition.filters.map((filter, index) => {
              const values = filters[filter.id] ?? []
              const optionQuery = optionQueries[index]!
              const options = optionQuery.data?.values ?? []
              return (
                <MultiSelectDropdown
                  className="w-48"
                  disabled={optionQuery.isPending}
                  emptyMessage="No values for this period"
                  key={filter.id}
                  onValueChangeAction={(next) =>
                    setFilters((current) => ({
                      ...current,
                      [filter.id]: filter.multiple ? next : next.slice(-1),
                    }))
                  }
                  options={options.map((value) => ({
                    icon: ListFilter,
                    label: value,
                    value,
                  }))}
                  placeholder={filter.label}
                  searchPlaceholder={`Search ${filter.label.toLowerCase()}`}
                  value={values}
                />
              )
            })}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-xs">Updates every 30 seconds</span>
            <Button
              onClick={() =>
                void queryClient.invalidateQueries({
                  predicate: (query) =>
                    query.meta?.workspaceId === workspaceId &&
                    query.meta.dashboardId === dashboard.id,
                })
              }
              size="sm"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-12 gap-4 px-4 md:px-6">{children}</div>
    </DashboardContext.Provider>
  )
}

export function DashboardWidgetCard({
  initialData,
  widget,
}: {
  initialData: DashboardWidgetResult
  widget: DashboardWidget
}) {
  const context = React.useContext(DashboardContext)
  if (!context) throw new Error("DashboardWidgetCard must be rendered inside DashboardView")
  const { dashboard, request, workspaceId } = context
  const [initialRequest] = React.useState(request)
  const query = useQuery(
    dashboardWidgetQueryOptions(
      workspaceId,
      dashboard.id,
      widget.id,
      request,
      request === initialRequest ? initialData : undefined
    )
  )
  const width =
    widget.width === "full"
      ? "col-span-12"
      : widget.width === "half"
        ? "col-span-12 lg:col-span-6"
        : "col-span-12 md:col-span-6 xl:col-span-4"

  return (
    <Card aria-busy={query.isFetching} className={width}>
      <CardHeader>
        <CardTitle>{widget.title}</CardTitle>
        {widget.description ? (
          <p className="text-muted-foreground text-xs">{widget.description}</p>
        ) : null}
      </CardHeader>
      <CardContent>
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
            widget={widget}
          />
        )}
      </CardContent>
    </Card>
  )
}

function WidgetContent({
  data,
  unit,
  widget,
}: {
  data: DashboardWidgetResult
  unit?: string
  widget: DashboardWidget
}) {
  if (widget.kind === "metric") {
    return (
      <div className="flex min-h-40 items-center">
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
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {data.columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, index) => (
            <TableRow key={index}>
              {row.cells.map((cell, cellIndex) => (
                <TableCell key={`${index}:${data.columns[cellIndex]}`}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  const config = Object.fromEntries(
    data.series.map((series, index) => [
      series.key,
      { label: series.label, color: chartColors[index % chartColors.length] },
    ])
  ) satisfies ChartConfig
  const points = data.points.map((point) => ({
    key: point.key,
    label: point.label,
    ...Object.fromEntries(
      data.series.map((series, index) => [series.key, point.values[index] ?? 0])
    ),
  }))
  const tooltip = (
    <ChartTooltip
      content={({ active, label, payload }) =>
        active && payload?.length ? (
          <div className="bg-popover text-popover-foreground min-w-32 rounded-lg border p-2 text-xs shadow-md">
            <p className="mb-1 font-medium">{label}</p>
            {payload.map((item) => (
              <div className="flex justify-between gap-4" key={String(item.dataKey)}>
                <span className="text-muted-foreground">{config[String(item.dataKey)]?.label}</span>
                <span className="font-mono tabular-nums">
                  {Number(item.value).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        ) : null
      }
    />
  )

  if (widget.kind === "donut") {
    return (
      <ChartContainer className="h-64 w-full" config={config}>
        <PieChart accessibilityLayer>
          {tooltip}
          <Pie data={points} dataKey="s0" innerRadius="55%" nameKey="label" outerRadius="82%">
            {points.map((point, index) => (
              <Cell fill={chartColors[index % chartColors.length]} key={point.key} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    )
  }

  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        axisLine={false}
        dataKey="label"
        minTickGap={28}
        tickFormatter={(label: string) => timeTickFormat.format(new Date(label))}
        tickLine={false}
      />
      <YAxis axisLine={false} tickLine={false} width={42} />
      {tooltip}
    </>
  )
  if (widget.kind === "line") {
    return (
      <ChartContainer className="h-64 w-full" config={config}>
        <LineChart data={points} accessibilityLayer>
          {common}
          {data.series.map((series, index) => (
            <Line
              dataKey={series.key}
              dot={false}
              key={series.key}
              stroke={chartColors[index % chartColors.length]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </LineChart>
      </ChartContainer>
    )
  }
  if (widget.kind === "area") {
    return (
      <ChartContainer className="h-64 w-full" config={config}>
        <AreaChart data={points} accessibilityLayer>
          {common}
          {data.series.map((series, index) => (
            <Area
              dataKey={series.key}
              fill={chartColors[index % chartColors.length]}
              fillOpacity={0.18}
              key={series.key}
              stackId={widget.stacked ? "dashboard" : undefined}
              stroke={chartColors[index % chartColors.length]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </AreaChart>
      </ChartContainer>
    )
  }
  return (
    <ChartContainer className="h-64 w-full" config={config}>
      <BarChart data={points} accessibilityLayer>
        {common}
        {data.series.map((series, index) => (
          <Bar
            dataKey={series.key}
            fill={chartColors[index % chartColors.length]}
            key={series.key}
            radius={[4, 4, 0, 0]}
            stackId={widget.stacked ? "dashboard" : undefined}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}
