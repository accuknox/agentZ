"use client"

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  DefaultTooltipContent,
  Label,
  Legend,
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
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { dayjs } from "@/lib/format"
import type { DashboardWidget, DashboardWidgetQueryResult } from "@/lib/gateway/client"

const colors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const resizeDebounce = 250

export function DashboardChart({
  result,
  widget,
}: {
  result: DashboardWidgetQueryResult
  widget: DashboardWidget
}) {
  const config = Object.fromEntries(
    widget.series.map((series, index) => [
      `s${index}`,
      { label: series.label, color: colors[index] },
    ])
  ) satisfies ChartConfig

  if (widget.kind === "line" || widget.kind === "step" || widget.kind === "area") {
    const data = result.points.map((point) =>
      Object.assign(
        { at: dayjs(point.at).format("lll") },
        Object.fromEntries(point.values.map((value, index) => [`s${index}`, value]))
      )
    )
    if (widget.kind === "area") {
      return (
        <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
          <AreaChart data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="at" minTickGap={28} />
            <YAxis width={40} />
            <ChartTooltip isAnimationActive={false} />
            <Legend />
            {widget.series.map((series, index) => (
              <Area
                dataKey={`s${index}`}
                fill={`var(--color-s${index})`}
                fillOpacity={0.14}
                isAnimationActive={false}
                key={series.name}
                name={series.label}
                stroke={`var(--color-s${index})`}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )
    }

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <LineChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="at" minTickGap={28} />
          <YAxis width={40} />
          <ChartTooltip isAnimationActive={false} />
          <Legend />
          {widget.series.map((series, index) => (
            <Line
              dataKey={`s${index}`}
              dot={false}
              isAnimationActive={false}
              key={series.name}
              name={series.label}
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
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <PieChart>
          <ChartTooltip isAnimationActive={false} />
          <Legend />
          <Pie
            data={data}
            dataKey="value"
            innerRadius={52}
            isAnimationActive={false}
            nameKey="name"
            outerRadius={92}
          >
            {data.map((item, index) => (
              <Cell key={item.name} fill={colors[index % colors.length]} />
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
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
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
          <ChartTooltip isAnimationActive={false} />
          <Legend />
          {widget.series.map((series, index) => (
            <Bar
              dataKey={`s${index}`}
              fill={`var(--color-s${index})`}
              isAnimationActive={false}
              key={series.name}
              name={series.label}
              radius={2}
            />
          ))}
        </BarChart>
      </ChartContainer>
    )
  }

  if (widget.kind === "scatter") {
    if (!widget.axes) {
      throw new Error(`scatter widget ${widget.name} is missing axes`)
    }

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <ScatterChart>
          <CartesianGrid />
          <XAxis dataKey="x" name={widget.axes.x.label} type="number" unit={widget.axes.x.unit} />
          <YAxis
            dataKey="y"
            name={widget.axes.y.label}
            type="number"
            unit={widget.axes.y.unit}
            width="auto"
          />
          <ChartTooltip
            content={(props) => (
              <DefaultTooltipContent {...props} label={props.payload?.[0]?.payload.label} />
            )}
            isAnimationActive={false}
          />
          <Legend />
          {widget.series.map((series, index) => (
            <Scatter
              data={result.scatter.filter((point) => point.series === index)}
              fill={`var(--color-s${index})`}
              isAnimationActive={false}
              key={series.name}
              name={series.label}
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
    tone === "critical" ? "var(--destructive)" : tone === "warning" ? "var(--warning)" : colors[0]

  return (
    <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
      <RadialBarChart
        data={[{ name: widget.series[0]?.label ?? widget.title, value: percent, fill }]}
        endAngle={-30}
        innerRadius="72%"
        outerRadius="100%"
        startAngle={210}
      >
        <PolarAngleAxis angleAxisId={0} domain={[0, 100]} tick={false} type="number" />
        <RadialBar background cornerRadius={4} dataKey="value" isAnimationActive={false} />
        <Label
          className="fill-foreground text-3xl font-semibold tabular-nums"
          position="center"
          value={value.toLocaleString()}
        />
        <Legend />
      </RadialBarChart>
    </ChartContainer>
  )
}
