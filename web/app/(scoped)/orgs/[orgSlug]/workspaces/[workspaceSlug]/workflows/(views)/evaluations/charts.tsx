"use client"

import { useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"
import { ChartContainer, ChartTooltip, chartColorProperty } from "@/components/ui/chart"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BarChart3, ScatterChart as ScatterIcon, Gauge, ScanSearch } from "lucide-react"
import type { WorkflowEvaluation } from "@/lib/gateway/client"
import { formatCompactNumber, formatDurationSeconds } from "@/lib/format"

const resources = [
  { key: "tokens", label: "Tokens" },
  { key: "tool_calls", label: "Tool calls" },
  { key: "duration_seconds", label: "Duration" },
] as const
const axis = {
  axisLine: false,
  tickLine: false,
  tickMargin: 8,
  tick: { fill: "var(--muted-foreground)", fontSize: 12 },
} as const

export function Charts({
  executions,
  pending,
}: {
  executions: WorkflowEvaluation["executions"]
  pending: boolean
}) {
  const [resourceKey, setResourceKey] = useState("tokens")
  const resource = resources.find((item) => item.key === resourceKey) ?? resources[0]
  const rows = executions.map((item, index) => ({
    run_name: item.run_name,
    name: item.model.label,
    tokens: item.tokens,
    tool_calls: item.tool_calls,
    duration_seconds: item.duration_seconds,
    color: `var(${chartColorProperty(index)})`,
    score: item.score === undefined ? undefined : Math.round(item.score * 10) / 10,
    correctness: item.judgment ? item.judgment.correctness * 25 : undefined,
    efficiency: item.judgment ? item.judgment.efficiency * 25 : undefined,
    measured:
      item.measured_efficiency === undefined
        ? undefined
        : Math.round(item.measured_efficiency * 1000) / 10,
  }))
  const modelRows = rows.map((row) => ({ ...row, fill: row.color }))
  const ranked = modelRows
    .filter((row) => row.score !== undefined)
    .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const usage = ranked.filter((row) => row[resource.key] !== undefined)
  return (
    <div className="bg-muted/30 grid min-w-0 grid-cols-1 gap-2 p-2 xl:grid-cols-2">
      <section
        className="bg-card min-w-0 overflow-hidden rounded-lg border shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_5%,transparent)]"
        aria-label="Score ranking"
      >
        <header className="from-card to-muted/20 flex h-12 items-center gap-2.5 border-b bg-gradient-to-r px-3.5">
          <BarChart3 className="text-muted-foreground size-4" />
          <h2 className="text-sm font-semibold">Score</h2>
        </header>
        {ranked.length ? (
          <ChartContainer
            resizeDebounce={250}
            config={{
              score: {
                label: "Score",
                color: `var(${chartColorProperty(0)})`,
              },
            }}
            className="h-[calc(20rem-3rem)] w-full p-3"
          >
            <BarChart
              data={ranked}
              layout="vertical"
              margin={{ left: 0, right: 38, bottom: 8 }}
              accessibilityLayer
            >
              <CartesianGrid horizontal={false} strokeDasharray="3 5" />
              <XAxis {...axis} type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} />
              <YAxis {...axis} type="category" dataKey="name" width={120} />
              <ChartTooltip isAnimationActive={false} />
              <Bar
                dataKey="score"
                name="Score"
                maxBarSize={26}
                radius={[0, 4, 4, 0]}
                isAnimationActive={false}
              >
                <LabelList dataKey="score" position="right" className="fill-foreground text-xs" />
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="text-muted-foreground flex h-[calc(20rem-3rem)] flex-col items-center justify-center gap-3 text-sm">
            {pending ? (
              <ScanSearch className="text-primary/40 size-7 motion-safe:animate-pulse" />
            ) : null}
            {pending ? "Waiting for judgments" : "No scores available"}
          </div>
        )}
      </section>
      <section
        className="bg-card min-w-0 overflow-hidden rounded-lg border shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_5%,transparent)]"
        aria-label="Score and resource tradeoffs"
      >
        <Tabs value={resourceKey} onValueChange={setResourceKey} className="gap-0">
          <div className="from-card to-muted/20 flex h-12 items-center justify-between gap-2 border-b bg-gradient-to-r px-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ScatterIcon className="text-muted-foreground size-4" />
              Score vs. usage
            </h2>
            <TabsList aria-label="Resource">
              <TabsTrigger value="tokens">Tokens</TabsTrigger>
              <TabsTrigger value="tool_calls">Calls</TabsTrigger>
              <TabsTrigger value="duration_seconds">Time</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value={resource.key}>
            {usage.length > 0 ? (
              <ChartContainer
                resizeDebounce={250}
                config={{ score: { label: "Score" } }}
                className="h-[calc(20rem-3rem)] w-full p-3"
              >
                <ScatterChart
                  margin={{ left: 0, right: 20, bottom: 20, top: 8 }}
                  accessibilityLayer
                >
                  <CartesianGrid strokeDasharray="3 5" />
                  <XAxis
                    {...axis}
                    type="number"
                    dataKey={resource.key}
                    name={resource.label}
                    tickFormatter={
                      resource.key === "duration_seconds"
                        ? formatDurationSeconds
                        : formatCompactNumber
                    }
                  />
                  <YAxis
                    {...axis}
                    type="number"
                    dataKey="score"
                    name="Score"
                    domain={[0, 100]}
                    width={36}
                  />
                  <ZAxis range={[75, 75]} />
                  <ChartTooltip cursor={{ strokeDasharray: "3 3" }} isAnimationActive={false} />
                  {usage.map((row) => (
                    <Scatter
                      key={row.run_name}
                      name={row.name}
                      data={[row]}
                      fill={row.fill}
                      isAnimationActive={false}
                    />
                  ))}
                  <Legend iconSize={8} wrapperStyle={{ paddingTop: 12 }} />
                </ScatterChart>
              </ChartContainer>
            ) : (
              <div className="text-muted-foreground flex h-[calc(20rem-3rem)] flex-col items-center justify-center gap-3 text-sm">
                No scored measurements
              </div>
            )}
          </TabsContent>
        </Tabs>
      </section>
      <section className="bg-card min-w-0 overflow-hidden rounded-lg border shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_5%,transparent)] xl:col-span-2">
        <Tabs defaultValue="scores" className="gap-0">
          <header className="from-card to-muted/20 flex h-12 items-center justify-between gap-2 border-b bg-gradient-to-r px-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Gauge className="text-muted-foreground size-4" />
              Model comparison
            </h2>
            <TabsList aria-label="Model comparison charts">
              <TabsTrigger value="scores">Scores</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
            </TabsList>
          </header>
          <TabsContent value="scores">
            <ChartContainer
              resizeDebounce={250}
              className="h-[calc(20rem-3rem)] w-full p-3"
              config={{
                correctness: {
                  label: "Correctness",
                  color: `var(${chartColorProperty(0)})`,
                },
                efficiency: {
                  label: "Judge efficiency",
                  color: `var(${chartColorProperty(1)})`,
                },
                measured: {
                  label: "Measured efficiency",
                  color: `var(${chartColorProperty(2)})`,
                },
              }}
            >
              <BarChart data={rows} margin={{ left: 0, right: 12, top: 8 }} accessibilityLayer>
                <CartesianGrid vertical={false} strokeDasharray="3 5" />
                <XAxis {...axis} dataKey="name" />
                <YAxis {...axis} domain={[0, 100]} width="auto" unit="%" />
                <ChartTooltip isAnimationActive={false} />
                <Legend iconSize={8} wrapperStyle={{ paddingTop: 12 }} />
                <Bar
                  dataKey="correctness"
                  name="Correctness (%)"
                  fill="var(--color-correctness)"
                  maxBarSize={24}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="efficiency"
                  name="Judge efficiency (%)"
                  fill="var(--color-efficiency)"
                  maxBarSize={24}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="measured"
                  name="Measured efficiency (%)"
                  fill="var(--color-measured)"
                  maxBarSize={24}
                  radius={[3, 3, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </ChartContainer>
          </TabsContent>
          <TabsContent value="usage">
            <div className="grid gap-3 p-3 md:grid-cols-3">
              {resources.map((resource) => (
                <div key={resource.key} className="min-w-0">
                  <h3 className="mt-3 text-xs font-medium">{resource.label}</h3>
                  <ChartContainer
                    resizeDebounce={250}
                    config={{ [resource.key]: { label: resource.label } }}
                    className="h-48 w-full"
                  >
                    <BarChart
                      data={modelRows.filter((row) => row[resource.key] !== undefined)}
                      margin={{ left: 0, right: 12, top: 12 }}
                      accessibilityLayer
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 5" />
                      <XAxis {...axis} dataKey="name" />
                      <YAxis
                        {...axis}
                        width="auto"
                        tickFormatter={
                          resource.key === "duration_seconds"
                            ? formatDurationSeconds
                            : formatCompactNumber
                        }
                      />
                      <ChartTooltip isAnimationActive={false} />
                      <Bar
                        dataKey={resource.key}
                        name={resource.label}
                        maxBarSize={30}
                        radius={[3, 3, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ChartContainer>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </section>
    </div>
  )
}
