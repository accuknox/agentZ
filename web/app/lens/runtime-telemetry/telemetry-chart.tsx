"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, type TooltipContentProps } from "recharts"
import type { TraceChartActionData } from "@/data/types"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"

const chartConfig = {
  telemetry: {
    label: "Events",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

interface TelemetryChartProps {
  data: TraceChartActionData
}

export function TelemetryChart({ data }: TelemetryChartProps) {
  const points = data.points.map((point, index) => ({
    ...point,
    bucket: String(index),
    telemetry: point.count,
  }))

  return (
    <section className="flex flex-col gap-2 px-6 py-3">
      <div className="flex items-center justify-end">
        <span className="text-muted-foreground text-xs">{data.total} events</span>
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
          <ChartTooltip content={(props) => <TelemetryChartTooltip {...props} />} />
          <Bar dataKey="telemetry" fill="var(--color-telemetry)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </section>
  )
}

function TelemetryChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) {
    return null
  }

  const point = telemetryPoint(payload[0]?.payload)
  if (!point) {
    return null
  }

  return (
    <div className="border-border/50 bg-background grid min-w-32 gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{point.label}</div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-muted-foreground">Events</span>
        <span className="text-foreground font-mono font-medium tabular-nums">
          {point.count.toLocaleString()}
        </span>
      </div>
    </div>
  )
}

function telemetryPoint(payload: unknown): { count: number; label: string } | undefined {
  if (!isTelemetryPoint(payload)) {
    return undefined
  }

  return payload
}

function isTelemetryPoint(payload: unknown): payload is { count: number; label: string } {
  if (!payload || typeof payload !== "object") {
    return false
  }

  return (
    "count" in payload &&
    typeof payload.count === "number" &&
    "label" in payload &&
    typeof payload.label === "string"
  )
}
