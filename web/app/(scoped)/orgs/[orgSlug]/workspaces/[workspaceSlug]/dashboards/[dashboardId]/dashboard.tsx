"use client"

import * as React from "react"
import type { Route } from "next"
import { useRouter } from "@bprogress/next/app"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { CalendarDays, LayoutDashboard, ListFilter, RefreshCw } from "lucide-react"
import type { DateRange } from "react-day-picker"
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
  type TooltipContentProps,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { dayjs } from "@/lib/format"
import {
  listDashboardFilterOptions,
  queryDashboardWidget,
  type Dashboard,
  type DashboardFilter,
  type DashboardQueryRequest,
  type DashboardSeries,
  type DashboardSummary,
  type DashboardTimeRange,
  type DashboardWidget,
  type DashboardWidgetResult,
} from "@/lib/gateway/client"
import { cn } from "@/lib/utils"

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const defaultDashboardDuration = 24 * 60 * 60 * 1000

type DashboardRange =
  | { duration: number; from: Date; kind: "live"; to: Date }
  | { from: Date; kind: "fixed"; selectedTo: Date; to: Date }

type DashboardContextValue = {
  dashboard: Dashboard
  liveDuration?: number
  request: DashboardQueryRequest
  workspaceId: string
}

const DashboardContext = React.createContext<DashboardContextValue | null>(null)

const dashboardWidgetQueryOptions = (
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  request: DashboardQueryRequest,
  liveDuration?: number,
  initialData?: DashboardWidgetResult
) =>
  queryOptions({
    queryKey: [
      "dashboard-widget",
      workspaceId,
      dashboardId,
      widgetId,
      request,
      liveDuration,
    ] as const,
    queryFn: async () => {
      const result = await queryDashboardWidget({
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { dashboardId, widgetId },
        body: {
          ...request,
          time_range: liveDuration ? recentTimeRange(liveDuration) : request.time_range,
        },
        throwOnError: false,
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    initialData,
    meta: { dashboardId, workspaceId },
    placeholderData: (previous) => previous,
    refetchInterval: liveDuration ? 30_000 : false,
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
  const queryClient = useQueryClient()
  const liveDuration = range.kind === "live" ? range.duration : undefined
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

  return (
    <DashboardContext.Provider value={{ dashboard, liveDuration, request, workspaceId }}>
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
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
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
      <div className="grid grid-cols-12 gap-x-10 gap-y-6 px-4 md:px-6">{children}</div>
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
      meta: { dashboardId, workspaceId },
      refetchInterval: liveDuration ? 30_000 : false,
      staleTime: 30_000,
    })
  )

  return (
    <MultiSelectDropdown
      className="w-48"
      disabled={query.isPending}
      emptyMessage="No values for this period"
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
  const { dashboard, liveDuration, request, workspaceId } = context
  const [initialRequest] = React.useState(request)
  const query = useQuery(
    dashboardWidgetQueryOptions(
      workspaceId,
      dashboard.id,
      widget.id,
      request,
      liveDuration,
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
    <section aria-busy={query.isFetching} className={cn(width, "min-w-0 py-2")}>
      <header className="mb-2 flex flex-col gap-1 px-1">
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
          widget={widget}
        />
      )}
    </section>
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
      <div className="flex min-h-16 items-end px-1 pb-2">
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
  const valuesByLabel = new Map<string | number, number[]>(
    data.points.map((point) => [point.label, point.values])
  )
  const tooltip = (
    <ChartTooltip
      content={(props) => (
        <DashboardChartTooltip {...props} series={data.series} valuesByLabel={valuesByLabel} />
      )}
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
        tickFormatter={(label: string) => dayjs(label).format("MMM D, h:mm A")}
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
              name={series.label}
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
              name={series.label}
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
            name={series.label}
            radius={[4, 4, 0, 0]}
            stackId={widget.stacked ? "dashboard" : undefined}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

function DashboardChartTooltip({
  active,
  label,
  series,
  valuesByLabel,
}: TooltipContentProps & {
  series: DashboardSeries[]
  valuesByLabel: Map<string | number, number[]>
}) {
  const values = label === undefined ? undefined : valuesByLabel.get(label)
  if (!active || !values) return null

  return (
    <div className="border-border/50 bg-background grid min-w-32 gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="grid gap-1.5">
        {series.map((item, index) => (
          <div className="flex items-center justify-between gap-4" key={item.key}>
            <span className="text-muted-foreground flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 rounded-sm"
                style={{ backgroundColor: chartColors[index % chartColors.length] }}
              />
              {item.label}
            </span>
            <span className="text-foreground font-mono font-medium tabular-nums">
              {values[index]?.toLocaleString() ?? "0"}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function recentTimeRange(duration: number): DashboardTimeRange {
  const to = dayjs()
  return {
    from: to.subtract(duration, "millisecond").toISOString(),
    to: to.toISOString(),
  }
}
