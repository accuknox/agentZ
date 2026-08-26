"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  DefaultTooltipContent,
  Funnel,
  FunnelChart,
  Label,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  Sankey,
  Scatter,
  ScatterChart,
  useChartWidth,
  XAxis,
  YAxis,
  type FunnelTrapezoidItem,
  type SankeyNodeProps,
} from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { dayjs } from "@/lib/format"
import type { DashboardWidget, DashboardWidgetQueryResult } from "@/lib/gateway/client"

const resizeDebounce = 250
const axis = { axisLine: false, tickLine: false } as const
const legend = {
  iconSize: 8,
  wrapperStyle: { paddingTop: 12 },
} as const

type FunnelDatum = {
  fill: string
  name: string
  value: number
}

export function DashboardChart({
  result,
  widget,
}: {
  result: DashboardWidgetQueryResult
  widget: DashboardWidget
}) {
  const gradientId = React.useId().replaceAll(":", "")
  const config = Object.fromEntries(
    widget.series.map((series, index) => [
      `s${index}`,
      { label: series.label, color: chartColor(index) },
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
          <AreaChart data={data} margin={{ left: 0, right: 12, top: 8 }}>
            <defs>
              {widget.series.map((series, index) => (
                <linearGradient
                  id={`${gradientId}-${series.name}`}
                  key={series.name}
                  x1="0"
                  x2="0"
                  y1="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={`var(--color-s${index})`} stopOpacity={0.28} />
                  <stop offset="92%" stopColor={`var(--color-s${index})`} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 5" vertical={false} />
            <XAxis {...axis} dataKey="at" minTickGap={28} tickMargin={10} />
            <YAxis {...axis} tickMargin={8} width={40} />
            <ChartTooltip isAnimationActive={false} />
            <Legend {...legend} />
            {widget.series.map((series, index) => (
              <Area
                dataKey={`s${index}`}
                fill={`url(#${gradientId}-${series.name})`}
                isAnimationActive={false}
                key={series.name}
                name={series.label}
                stroke={`var(--color-s${index})`}
                strokeWidth={2.25}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )
    }

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <LineChart data={data} margin={{ left: 0, right: 12, top: 8 }}>
          <CartesianGrid strokeDasharray="3 5" vertical={false} />
          <XAxis {...axis} dataKey="at" minTickGap={28} tickMargin={10} />
          <YAxis {...axis} tickMargin={8} width={40} />
          <ChartTooltip isAnimationActive={false} />
          <Legend {...legend} />
          {widget.series.map((series, index) => (
            <Line
              activeDot={{ r: 4, strokeWidth: 2 }}
              dataKey={`s${index}`}
              dot={false}
              isAnimationActive={false}
              key={series.name}
              name={series.label}
              stroke={`var(--color-s${index})`}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2.25}
              type={widget.kind === "step" ? "stepAfter" : "monotone"}
            />
          ))}
        </LineChart>
      </ChartContainer>
    )
  }

  if (widget.kind === "pie") {
    const data = result.categories.map((category, index) => ({
      fill: chartColor(index),
      name: category.label,
      value: category.values.reduce((sum, value) => sum + value, 0),
    }))
    const total = data.reduce((sum, item) => sum + item.value, 0)

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <PieChart margin={{ bottom: 8, top: 8 }}>
          <ChartTooltip isAnimationActive={false} />
          <Legend {...legend} />
          <Pie
            cornerRadius={4}
            data={data}
            dataKey="value"
            innerRadius="54%"
            isAnimationActive={false}
            nameKey="name"
            outerRadius="82%"
            paddingAngle={2}
            stroke="var(--background)"
            strokeWidth={2}
          >
            <Label
              className="fill-foreground text-lg font-semibold tabular-nums"
              position="center"
              value={total.toLocaleString()}
            />
            {data.map((item) => (
              <Cell fill={item.fill} key={item.name} />
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
        <BarChart
          data={data}
          layout={horizontal ? "vertical" : "horizontal"}
          margin={{ left: horizontal ? 12 : 0, right: 12, top: 8 }}
        >
          <CartesianGrid horizontal={!horizontal} strokeDasharray="3 5" vertical={horizontal} />
          {horizontal ? (
            <>
              <XAxis {...axis} tickMargin={8} type="number" />
              <YAxis {...axis} dataKey="category" tickMargin={8} type="category" width={88} />
            </>
          ) : (
            <>
              <XAxis {...axis} dataKey="category" tickMargin={10} />
              <YAxis {...axis} tickMargin={8} width={40} />
            </>
          )}
          <ChartTooltip isAnimationActive={false} />
          <Legend {...legend} />
          {widget.series.map((series, index) => (
            <Bar
              dataKey={`s${index}`}
              fill={`var(--color-s${index})`}
              isAnimationActive={false}
              key={series.name}
              maxBarSize={32}
              name={series.label}
              radius={horizontal ? [0, 5, 5, 0] : [5, 5, 0, 0]}
            />
          ))}
        </BarChart>
      </ChartContainer>
    )
  }

  if (widget.kind === "funnel" || widget.kind === "horizontal_funnel") {
    const data: FunnelDatum[] = result.categories.map((category, index) => ({
      fill: chartColor(index),
      name: category.label,
      value: category.values.reduce((sum, value) => sum + value, 0),
    }))
    const horizontal = widget.kind === "horizontal_funnel"

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <FunnelChart margin={{ bottom: 16, left: 24, right: horizontal ? 24 : 80, top: 16 }}>
          <ChartTooltip isAnimationActive={false} />
          <Funnel
            data={data}
            dataKey="value"
            isAnimationActive={false}
            lastShapeType="rectangle"
            nameKey="name"
            shape={
              horizontal ? (props) => <HorizontalFunnelShape {...props} data={data} /> : undefined
            }
            stroke="var(--background)"
            strokeWidth={2}
          >
            {horizontal ? null : (
              <LabelList
                className="fill-muted-foreground text-[11px] font-medium"
                dataKey="name"
                position="right"
                stroke="none"
              />
            )}
          </Funnel>
        </FunnelChart>
      </ChartContainer>
    )
  }

  if (widget.kind === "sankey") {
    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <Sankey
          data={{ nodes: result.sankey_nodes, links: result.sankey_links }}
          dataKey="value"
          iterations={48}
          link={{ stroke: "var(--chart-2)", strokeOpacity: 0.24 }}
          margin={{ bottom: 18, left: 18, right: 18, top: 18 }}
          nameKey="name"
          node={(props) => <DashboardSankeyNode {...props} names={result.sankey_nodes} />}
          nodePadding={24}
          nodeWidth={12}
        >
          <ChartTooltip isAnimationActive={false} />
        </Sankey>
      </ChartContainer>
    )
  }

  if (widget.kind === "scatter") {
    if (!widget.axes) {
      throw new Error(`scatter widget ${widget.name} is missing axes`)
    }

    return (
      <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
        <ScatterChart margin={{ bottom: 4, left: 4, right: 16, top: 8 }}>
          <CartesianGrid strokeDasharray="3 5" />
          <XAxis
            {...axis}
            dataKey="x"
            name={widget.axes.x.label}
            tickMargin={8}
            type="number"
            unit={widget.axes.x.unit}
          />
          <YAxis
            {...axis}
            dataKey="y"
            name={widget.axes.y.label}
            tickMargin={8}
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
          <Legend {...legend} />
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
    tone === "critical"
      ? "var(--destructive)"
      : tone === "warning"
        ? "var(--warning)"
        : chartColor(0)

  return (
    <ChartContainer className="h-full w-full" config={config} resizeDebounce={resizeDebounce}>
      <RadialBarChart
        data={[{ name: widget.series[0]?.label ?? widget.title, value: percent, fill }]}
        endAngle={-32}
        innerRadius="72%"
        outerRadius="100%"
        startAngle={212}
      >
        <PolarAngleAxis angleAxisId={0} domain={[0, 100]} tick={false} type="number" />
        <RadialBar
          background={{ fill: "var(--muted)" }}
          cornerRadius={8}
          dataKey="value"
          isAnimationActive={false}
        />
        <Label
          className="fill-foreground text-3xl font-semibold tabular-nums"
          position="center"
          value={value.toLocaleString()}
        />
      </RadialBarChart>
    </ChartContainer>
  )
}

function HorizontalFunnelShape({
  data,
  name,
  parentViewBox,
}: FunnelTrapezoidItem & { data: FunnelDatum[] }) {
  const index = data.findIndex((item) => item.name === name)
  const item = data[index]
  if (!item) return null

  const next = data[index + 1] ?? item
  const max = Math.max(...data.map((stage) => stage.value), 1)
  const segment = parentViewBox.width / data.length
  const x1 = parentViewBox.x + segment * index
  const x2 = x1 + segment
  const center = parentViewBox.y + parentViewBox.height / 2
  const left = (item.value / max) * parentViewBox.height * 0.42
  const right = (next.value / max) * parentViewBox.height * 0.42
  const path = `M ${x1} ${center - left} L ${x2} ${center - right} L ${x2} ${center + right} L ${x1} ${center + left} Z`

  return (
    <g>
      <path d={path} fill={item.fill} stroke="var(--background)" strokeWidth={2} />
      <text
        className="fill-primary-foreground text-[10px] font-semibold"
        dominantBaseline="middle"
        textAnchor="middle"
        x={(x1 + x2) / 2}
        y={center}
      >
        {item.name}
      </text>
    </g>
  )
}

function DashboardSankeyNode({
  names,
  ...props
}: SankeyNodeProps & { names: DashboardWidgetQueryResult["sankey_nodes"] }) {
  const chartWidth = useChartWidth()
  if (chartWidth == null) return null

  const outside = props.x + props.width + 88 > chartWidth
  const node = names[props.index]
  if (!node) return null

  const x = outside ? props.x - 7 : props.x + props.width + 7
  const anchor = outside ? "end" : "start"
  const color = chartColor(props.payload.depth)

  return (
    <g>
      <rect
        fill={color}
        height={Math.max(props.height, 4)}
        rx={3}
        width={props.width}
        x={props.x}
        y={props.y}
      />
      <text
        className="fill-foreground text-[10px] font-medium"
        dominantBaseline="middle"
        textAnchor={anchor}
        x={x}
        y={props.y + props.height / 2 - 6}
      >
        {node.name}
      </text>
      <text
        className="fill-muted-foreground text-[9px] tabular-nums"
        dominantBaseline="middle"
        textAnchor={anchor}
        x={x}
        y={props.y + props.height / 2 + 7}
      >
        {props.payload.value.toLocaleString()}
      </text>
    </g>
  )
}

function chartColor(index: number): string {
  switch (index % 5) {
    case 0:
      return "var(--chart-2)"
    case 1:
      return "var(--chart-4)"
    case 2:
      return "var(--chart-1)"
    case 3:
      return "var(--chart-3)"
    default:
      return "var(--chart-5)"
  }
}
