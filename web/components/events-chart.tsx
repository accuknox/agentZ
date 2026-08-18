"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, type TooltipContentProps } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import type { EventsChartData, EventsChartPoint } from "@/data/types"

export function EventsChart({ data, label = "Events" }: { data: EventsChartData; label?: string }) {
  const chartConfig = {
    events: {
      label,
      color: "var(--chart-2)",
    },
  } satisfies ChartConfig
  const points = data.points.map((point, index) => ({
    ...point,
    bucket: String(index),
    events: point.count,
  }))

  return (
    <section className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:px-6">
      <div className="flex items-center justify-end">
        <span className="text-muted-foreground text-xs">
          {data.total} {label.toLowerCase()}
        </span>
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
          <ChartTooltip
            content={(props) => <EventsChartTooltip {...props} name={label} points={points} />}
          />
          <Bar dataKey="events" fill="var(--color-events)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </section>
  )
}

type EventsChartTooltipPoint = EventsChartPoint & {
  bucket: string
  events: number
}

function EventsChartTooltip({
  active,
  label,
  payload,
  name,
  points,
}: TooltipContentProps & {
  name: string
  points: EventsChartTooltipPoint[]
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
        <span className="text-muted-foreground">{name}</span>
        <span className="text-foreground font-mono font-medium tabular-nums">
          {point.count.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
