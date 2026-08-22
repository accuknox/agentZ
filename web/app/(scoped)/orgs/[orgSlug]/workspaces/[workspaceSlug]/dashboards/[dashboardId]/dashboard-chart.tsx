"use client"

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
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { dayjs } from "@/lib/format"
import type { DashboardSeries, DashboardWidget, DashboardWidgetResult } from "@/lib/gateway/client"

const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

export function DashboardChart({
  data,
  kind,
  stacked,
}: {
  data: DashboardWidgetResult
  kind: Exclude<DashboardWidget["kind"], "metric" | "table">
  stacked?: boolean
}) {
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
      isAnimationActive={false}
    />
  )

  if (kind === "donut") {
    return (
      <ChartContainer className="h-64 w-full" config={config} resizeDebounce={250}>
        <PieChart accessibilityLayer>
          {tooltip}
          <Pie
            data={points}
            dataKey="s0"
            innerRadius="55%"
            isAnimationActive={false}
            nameKey="label"
            outerRadius="82%"
          >
            {points.map((point, index) => (
              <Cell fill={chartColors[index % chartColors.length]} key={point.key} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    )
  }

  const axes = (
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
  if (kind === "line") {
    return (
      <ChartContainer className="h-64 w-full" config={config} resizeDebounce={250}>
        <LineChart data={points} accessibilityLayer>
          {axes}
          {data.series.map((series, index) => (
            <Line
              dataKey={series.key}
              dot={false}
              isAnimationActive={false}
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
  if (kind === "area") {
    return (
      <ChartContainer className="h-64 w-full" config={config} resizeDebounce={250}>
        <AreaChart data={points} accessibilityLayer>
          {axes}
          {data.series.map((series, index) => (
            <Area
              dataKey={series.key}
              fill={chartColors[index % chartColors.length]}
              fillOpacity={0.18}
              isAnimationActive={false}
              key={series.key}
              name={series.label}
              stackId={stacked ? "dashboard" : undefined}
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
    <ChartContainer className="h-64 w-full" config={config} resizeDebounce={250}>
      <BarChart data={points} accessibilityLayer>
        {axes}
        {data.series.map((series, index) => (
          <Bar
            dataKey={series.key}
            fill={chartColors[index % chartColors.length]}
            isAnimationActive={false}
            key={series.key}
            name={series.label}
            radius={[4, 4, 0, 0]}
            stackId={stacked ? "dashboard" : undefined}
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
