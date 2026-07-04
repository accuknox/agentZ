"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, type TooltipContentProps } from "recharts"
import type { TraceChartActionData, TraceChartPoint } from "@/data/types"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"

const chartConfig = {
  traces: {
    label: "Traces",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

export function TracesChart({ data }: { data: TraceChartActionData }) {
  const points = data.points.map((point, index) => ({
    ...point,
    bucket: String(index),
    traces: point.count,
  }))

  return (
    <section className="flex flex-col gap-2 px-6 py-3">
      <div className="flex items-center justify-end">
        <span className="text-muted-foreground text-xs">{data.total} traces</span>
      </div>
      <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
        <BarChart
          accessibilityLayer
          data={points}
          margin={{
            left: 0,
            right: 8,
            top: 8,
          }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucket"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={28}
            tickFormatter={(value) => points[Number(value)]?.label ?? ""}
          />
          <YAxis allowDecimals={false} hide />
          <ChartTooltip content={(props) => <TraceChartTooltip {...props} points={points} />} />
          <Bar dataKey="traces" fill="var(--color-traces)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </section>
  )
}

type TraceChartTooltipPoint = TraceChartPoint & {
  bucket: string
  traces: number
}

function TraceChartTooltip({
  active,
  label,
  payload,
  points,
}: TooltipContentProps & {
  points: TraceChartTooltipPoint[]
}) {
  if (!active || !payload?.length) {
    return null
  }

  const point = points[Number(label)]
  if (!point) {
    return null
  }

  return (
    <div className="border-border/50 bg-background grid min-w-32 gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Traces</span>
        <span className="text-foreground font-mono font-medium tabular-nums">
          {point.count.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
