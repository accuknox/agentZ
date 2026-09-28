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
import { CircleAlert, Download, FunctionSquare } from "lucide-react"
import type { WorkflowEvaluation } from "@/lib/gateway/client"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { formatCompactNumber, formatDurationSeconds } from "@/lib/format"

const resources = [
  { key: "tokens", label: "Tokens", unit: "tokens" },
  { key: "tool_calls", label: "Tool calls", unit: "calls" },
  { key: "duration_seconds", label: "Duration", unit: "s" },
  { key: "cost", label: "Recorded cost", unit: "USD" },
] as const
const axis = { axisLine: false, tickLine: false } as const

export function Results({ evaluation }: { evaluation: WorkflowEvaluation }) {
  const [selected, setSelected] = useState<string>()
  const execution = evaluation.executions.find((item) => item.run_name === selected)
  const rows = evaluation.executions.map((item, index) => ({
    ...item,
    name: item.model.label,
    failed: item.run_status === "Failed" || item.run_status === "Unacked",
    color: `var(--chart-${(index % 5) + 1})`,
    score: item.score === undefined ? undefined : Math.round(item.score * 10) / 10,
    correctness: item.judgment ? (item.judgment.correctness / 4) * 100 : undefined,
    efficiency: item.judgment ? (item.judgment.efficiency / 4) * 100 : undefined,
    measured:
      item.measured_efficiency === undefined
        ? undefined
        : Math.round(item.measured_efficiency * 1000) / 10,
  }))
  const ranked = rows
    .filter((row) => row.score !== undefined)
    .toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const completed = rows.filter((row) =>
    ["completed", "error", "cancelled"].includes(row.state)
  ).length
  const pending = ["queued", "running", "cancelling"].includes(evaluation.state)
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs sm:px-6">
        <span className="text-muted-foreground">
          Judge <span className="text-foreground">{evaluation.request.judge.label}</span>
        </span>
        {pending ? (
          <span className="flex items-center gap-2" role="status">
            <Spinner />
            {completed}/{rows.length} complete
          </span>
        ) : null}
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto">
              <FunctionSquare />
              Scoring
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Scoring</DialogTitle>
              <DialogDescription>trace-v1 · Relative to this evaluation</DialogDescription>
            </DialogHeader>
            <code className="bg-muted rounded-md p-3 text-sm">
              100 × Q × (0.80 + 0.10J + 0.10D)
            </code>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell>Q</TableCell>
                  <TableCell>Judge correctness ÷ 4</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>J</TableCell>
                  <TableCell>Judge efficiency ÷ 4</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>D</TableCell>
                  <TableCell>Mean token, tool-call, and duration ratios</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p className="text-sm">
              Each ratio is median ÷ (median + usage). Zero ÷ zero is 0.5. Medians freeze after
              execution, before judging.
            </p>
            {evaluation.references ? (
              <div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
                <span>{evaluation.references.tokens.toLocaleString()} tokens</span>
                <span>{evaluation.references.tool_calls.toLocaleString()} calls</span>
                <span>{formatDurationSeconds(evaluation.references.duration_seconds)}</span>
              </div>
            ) : null}
            <p className="text-sm">
              Failed runs or correctness below 3/4 score zero. Missing evidence or measurements
              remain unscored.
            </p>
            <p className="text-muted-foreground text-xs">
              Weights are product policy. Scores compare this group of executions, not different
              workflows. Cost is reported separately.
            </p>
          </DialogContent>
        </Dialog>
      </div>
      {evaluation.message ? (
        <Alert variant="destructive" className="mx-4 mb-3 w-auto">
          <CircleAlert />
          <AlertDescription>{evaluation.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-4 px-4 pb-4 sm:px-6 xl:grid-cols-2">
        <section className="min-w-0 rounded-lg border p-4" aria-label="Score ranking">
          <h2 className="mb-4 text-sm font-medium">Score</h2>
          {ranked.length ? (
            <ChartContainer
              config={{ score: { label: "Score", color: "var(--chart-2)" } }}
              className="h-72 w-full"
            >
              <BarChart
                data={ranked.map((row) => ({ ...row, fill: row.color }))}
                layout="vertical"
                margin={{ left: 0, right: 38, bottom: 8 }}
                accessibilityLayer
              >
                <CartesianGrid horizontal={false} strokeDasharray="3 5" />
                <XAxis {...axis} type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} />
                <YAxis
                  {...axis}
                  type="category"
                  dataKey="name"
                  width={140}
                  tick={{ fontSize: 12 }}
                />
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
            <div className="text-muted-foreground flex h-72 items-center justify-center text-sm">
              {pending ? "Waiting for judgments" : "No scores available"}
            </div>
          )}
        </section>
        <section
          className="min-w-0 rounded-lg border p-4"
          aria-label="Score and resource tradeoffs"
        >
          <Tabs defaultValue="tokens">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Score vs. usage</h2>
              <TabsList aria-label="Resource">
                <TabsTrigger value="tokens">Tokens</TabsTrigger>
                <TabsTrigger value="tool_calls">Calls</TabsTrigger>
                <TabsTrigger value="duration_seconds">Time</TabsTrigger>
                <TabsTrigger value="cost">Cost</TabsTrigger>
              </TabsList>
            </div>
            {resources.map((resource) => (
              <TabsContent key={resource.key} value={resource.key}>
                {ranked.some((row) => row[resource.key] !== undefined) ? (
                  <ChartContainer config={{ score: { label: "Score" } }} className="h-72 w-full">
                    <ScatterChart
                      margin={{ left: 0, right: 20, bottom: 20, top: 15 }}
                      accessibilityLayer
                    >
                      <CartesianGrid strokeDasharray="3 5" />
                      <XAxis
                        {...axis}
                        type="number"
                        dataKey={resource.key}
                        name={resource.label}
                        tickFormatter={formatCompactNumber}
                        label={{ value: resource.unit, position: "insideBottom", offset: -12 }}
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
                      {ranked
                        .filter((row) => row[resource.key] !== undefined)
                        .map((row) => (
                          <Scatter
                            key={row.run_name}
                            name={row.name}
                            data={[row]}
                            fill={row.color}
                            isAnimationActive={false}
                          />
                        ))}
                      <Legend iconSize={8} wrapperStyle={{ paddingTop: 18 }} />
                    </ScatterChart>
                  </ChartContainer>
                ) : (
                  <div className="text-muted-foreground flex h-72 items-center justify-center text-sm">
                    No scored measurements
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </section>
        <section className="min-w-0 rounded-lg border p-4 xl:col-span-2">
          <Tabs defaultValue="ratings">
            <TabsList aria-label="Measurement charts">
              <TabsTrigger value="ratings">Ratings</TabsTrigger>
              <TabsTrigger value="resources">Resources</TabsTrigger>
            </TabsList>
            <TabsContent value="ratings">
              <ChartContainer
                className="h-64 w-full"
                config={{
                  correctness: { label: "Correctness", color: "var(--chart-2)" },
                  efficiency: { label: "Judge efficiency", color: "var(--chart-1)" },
                  measured: { label: "Measured efficiency", color: "var(--chart-3)" },
                }}
              >
                <BarChart data={rows} margin={{ left: 0, right: 12, top: 18 }} accessibilityLayer>
                  <CartesianGrid vertical={false} strokeDasharray="3 5" />
                  <XAxis {...axis} dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis {...axis} domain={[0, 100]} width={40} unit="%" />
                  <ChartTooltip isAnimationActive={false} />
                  <Legend iconSize={8} />
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
            <TabsContent value="resources">
              <div className="grid gap-6 md:grid-cols-2">
                {resources.map((resource) => (
                  <div key={resource.key} className="min-w-0">
                    <h3 className="mt-3 text-xs font-medium">{resource.label}</h3>
                    <ChartContainer
                      config={{ [resource.key]: { label: resource.label } }}
                      className="h-48 w-full"
                    >
                      <BarChart
                        data={rows
                          .filter((row) => row[resource.key] !== undefined)
                          .map((row) => ({ ...row, fill: row.color }))}
                        margin={{ left: 0, right: 12, top: 12 }}
                        accessibilityLayer
                      >
                        <CartesianGrid vertical={false} strokeDasharray="3 5" />
                        <XAxis {...axis} dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis {...axis} width={42} tickFormatter={formatCompactNumber} />
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Score</TableHead>
            <TableHead className="text-right">Correctness</TableHead>
            <TableHead className="text-right">Judge efficiency</TableHead>
            <TableHead className="text-right">Measured efficiency</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.run_name}>
              <TableCell>
                <Button
                  variant="link"
                  onClick={() => setSelected(row.run_name)}
                  className="max-w-64 justify-start px-0"
                >
                  <span className="truncate">{row.name}</span>
                </Button>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    row.state === "error" || row.failed
                      ? "destructive"
                      : row.state === "completed"
                        ? "success"
                        : "secondary"
                  }
                >
                  {row.failed
                    ? row.run_status
                    : row.state === "error" && row.transcript
                      ? "Judge failed"
                      : row.state}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {row.score?.toFixed(1) ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.judgment ? `${row.judgment.correctness}/4` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.judgment ? `${row.judgment.efficiency}/4` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.measured_efficiency?.toFixed(3) ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.tokens?.toLocaleString() ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.tool_calls ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.duration_seconds === undefined
                  ? "—"
                  : formatDurationSeconds(row.duration_seconds)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.cost === undefined ? "—" : `$${row.cost.toFixed(4)}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Sheet
        open={!!execution}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
      >
        <SheetContent className="flex w-full flex-col data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{execution?.model.label}</SheetTitle>
            <SheetDescription>{execution?.run_name}</SheetDescription>
          </SheetHeader>
          {execution ? (
            <Tabs defaultValue="judgment" className="min-h-0 flex-1 px-4 pb-4">
              <TabsList aria-label="Execution details">
                <TabsTrigger value="judgment">Judgment</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
              </TabsList>
              <TabsContent value="judgment" className="overflow-y-auto">
                {execution.message ? (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{execution.message}</AlertDescription>
                  </Alert>
                ) : null}
                {execution.judgment && execution.score === undefined ? (
                  <p className="text-muted-foreground py-3 text-sm">
                    Score unavailable. Complete token, tool-call, and timing measurements are
                    required.
                  </p>
                ) : null}
                {execution.judgment ? (
                  <div className="flex flex-col gap-5 py-4">
                    {execution.judge_context_compacted ? (
                      <Badge variant="secondary">Compacted context</Badge>
                    ) : null}
                    <div className="flex flex-wrap gap-6">
                      <div>
                        <p className="text-muted-foreground text-xs">Correctness</p>
                        <p className="text-2xl tabular-nums">
                          {execution.judgment.correctness}
                          <span className="text-muted-foreground text-sm">/4</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">Efficiency</p>
                        <p className="text-2xl tabular-nums">
                          {execution.judgment.efficiency}
                          <span className="text-muted-foreground text-sm">/4</span>
                        </p>
                      </div>
                    </div>
                    <p className="text-sm">{execution.judgment.summary}</p>
                    <section>
                      <h3 className="mb-2 text-sm font-medium">Evidence</h3>
                      <ul className="flex list-disc flex-col gap-3 pl-5 text-sm">
                        {execution.judgment.evidence.map((item, index) => (
                          <li key={index} className="break-words">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </section>
                    {execution.judgment.limitations.length ? (
                      <section>
                        <h3 className="mb-2 text-sm font-medium">Limitations</h3>
                        <ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 text-sm">
                          {execution.judgment.limitations.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground py-6 text-sm">No judgment available</p>
                )}
              </TabsContent>
              <TabsContent value="transcript" className="min-h-0 overflow-y-auto">
                <div className="flex items-center justify-between py-3">
                  <span className="text-muted-foreground text-xs">
                    {execution.transcript?.length ?? 0}{" "}
                    {execution.transcript?.length === 1 ? "session" : "sessions"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!execution.transcript}
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob(
                          [
                            JSON.stringify(
                              {
                                workflow: evaluation.workflow,
                                inputs: evaluation.request.inputs,
                                execution,
                              },
                              null,
                              2
                            ),
                          ],
                          { type: "application/json" }
                        )
                      )
                      const link = document.createElement("a")
                      link.href = url
                      link.download = `${execution.run_name}.json`
                      link.click()
                      setTimeout(() => URL.revokeObjectURL(url), 1000)
                    }}
                  >
                    <Download />
                    Download
                  </Button>
                </div>
                {execution.transcript?.map((session) => (
                  <details key={session.session_id} className="mb-3 rounded-md border">
                    <summary className="cursor-pointer p-3 font-mono text-xs">
                      {session.session_id} · {session.messages.length} messages
                    </summary>
                    <pre className="bg-muted overflow-auto p-3 text-xs">
                      {JSON.stringify(session, null, 2)}
                    </pre>
                  </details>
                ))}
              </TabsContent>
            </Tabs>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
