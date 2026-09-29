"use client"

import { useId, useState } from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { getWorkflowEvaluationOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import {
  Scale,
  CircleAlert,
  FunctionSquare,
  FileInput,
  Check,
  Clock3,
  Play,
  ScanSearch,
} from "lucide-react"
import type {
  WorkflowEvaluation,
  EvaluationEvidenceReference,
  JsonValue,
} from "@/lib/gateway/client"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
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
import { Sheet } from "@/components/ui/sheet"
import { TraceInspectorSheet, TraceInspectorSkeleton } from "@/components/trace-inspector"
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
import { ProviderIcons } from "@/app/(app)/inference/providers/provider-shared"
import { formatDurationSeconds } from "@/lib/format"
import { cn } from "@/lib/utils"

const Transcript = dynamic(() => import("./transcript").then((module) => module.Transcript), {
  loading: () => <TraceInspectorSkeleton />,
})

const Charts = dynamic(() => import("./charts").then((module) => module.Charts), {
  loading: () => <ChartsSkeleton />,
  ssr: false,
})

const resultColumns = [
  "Model",
  "Status",
  "Score",
  "Correctness",
  "Judge efficiency",
  "Measured efficiency",
  "Tokens",
  "Calls",
  "Duration",
]

export function ResultsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading evaluation"
      className="motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      <div aria-hidden className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <Table aria-hidden>
        <TableHeader>
          <TableRow>
            {resultColumns.map((name, index) => (
              <TableHead key={name} className={index > 1 ? "text-right" : undefined}>
                {name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, row) => (
            <TableRow key={row}>
              {resultColumns.map((name, index) => (
                <TableCell key={name}>
                  <Skeleton
                    className={
                      index === 0
                        ? "h-4 w-36"
                        : index === 1
                          ? "h-5 w-20 rounded-full"
                          : "ml-auto h-4 w-12"
                    }
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ChartsSkeleton />
    </div>
  )
}

function ChartsSkeleton() {
  return (
    <div
      aria-hidden
      className="bg-muted/30 grid min-w-0 grid-cols-1 gap-2 p-2 xl:grid-cols-2 motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      {["Score", "Score vs. usage", "Model comparison"].map((title, index) => (
        <section
          key={title}
          className={
            index === 2
              ? "bg-card h-80 overflow-hidden rounded-lg border xl:col-span-2"
              : "bg-card h-80 overflow-hidden rounded-lg border"
          }
        >
          <header className="from-card to-muted/20 flex h-12 items-center gap-2.5 border-b bg-gradient-to-r px-3.5">
            <Skeleton className="size-4" />
            <h2 className="text-sm font-semibold">{title}</h2>
            {index > 0 ? <Skeleton className="ml-auto h-7 w-32" /> : null}
          </header>
          <div className="flex h-[calc(20rem-3rem)] flex-col gap-3 p-6">
            <div className="relative min-h-0 flex-1 border-b border-l">
              {index === 0 ? (
                <div className="flex h-full flex-col justify-around py-4">
                  <Skeleton className="h-6 w-3/4 rounded-l-none" />
                  <Skeleton className="h-6 w-2/3 rounded-l-none" />
                </div>
              ) : index === 1 ? (
                <>
                  <Skeleton className="absolute top-1/4 left-2/3 size-3 rounded-full" />
                  <Skeleton className="absolute top-1/3 left-1/2 size-3 rounded-full" />
                </>
              ) : (
                <div className="flex h-full items-end justify-around gap-6 px-6">
                  {["h-2/3", "h-1/2", "h-3/4", "h-1/3"].map((height) => (
                    <Skeleton key={height} className={cn("w-6 rounded-b-none", height)} />
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-center gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}

export function Results({
  evaluation,
  workspaceId,
  providerBrands,
}: {
  evaluation: WorkflowEvaluation
  workspaceId: string
  providerBrands: Record<string, string[]>
}) {
  const [selected, setSelected] = useState<string>()
  const [tab, setTab] = useState("judgment")
  const [reference, setReference] = useState<EvaluationEvidenceReference>()
  const execution = evaluation.executions.find((item) => item.run_name === selected)
  const evidenceReady = execution && !["queued", "running"].includes(execution.state)
  const evidence = useQuery({
    ...getWorkflowEvaluationOptions({
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      path: {
        agentName: evaluation.workflow.agent_name,
        workflowName: evaluation.workflow.workflow_name,
        evaluationId: evaluation.id,
      },
      query: { transcript_run: selected },
    }),
    enabled: !!evidenceReady && tab === "transcript",
  })
  const recordedExecution = evidence.data?.executions.find((item) => item.run_name === selected)
  const rows = evaluation.executions
  const completed = rows.filter((row) =>
    ["completed", "error", "cancelled"].includes(row.state)
  ).length
  const pending = ["queued", "running", "cancelling"].includes(evaluation.state)
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs sm:px-6">
        <span className="text-muted-foreground inline-flex items-center gap-2">
          <Scale aria-hidden className="size-4" />
          Judge
          <ProviderIcons
            className="text-foreground size-4 shrink-0"
            providers={
              providerBrands[
                JSON.stringify([
                  evaluation.request.judge.provider_id,
                  evaluation.request.judge.model_id,
                ])
              ] ?? []
            }
          />
          <span className="text-foreground">{evaluation.request.judge.label}</span>
        </span>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto">
              <FileInput />
              View inputs
            </Button>
          </DialogTrigger>
          <DialogContent
            className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-2xl"
            aria-describedby={undefined}
          >
            <DialogHeader>
              <DialogTitle>Evaluation inputs</DialogTitle>
            </DialogHeader>
            <div className="min-w-0 overflow-y-auto p-1">
              <EvaluationInput value={evaluation.request.inputs} />
            </div>
          </DialogContent>
        </Dialog>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm">
              <FunctionSquare />
              Scoring
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Scoring</DialogTitle>
              <DialogDescription>
                {evaluation.scoring_version} · Scores within this evaluation
              </DialogDescription>
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
              Ratio = median ÷ (median + usage). Medians are fixed before judging. Both zero → 0.5.
            </p>
            {evaluation.references ? (
              <div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
                <span>{evaluation.references.tokens.toLocaleString()} tokens</span>
                <span>{evaluation.references.tool_calls.toLocaleString()} calls</span>
                <span>{formatDurationSeconds(evaluation.references.duration_seconds)}</span>
              </div>
            ) : null}
            <p className="text-sm">
              Failed runs or correctness below 3/4 → 0. Missing evidence or metrics → unscored.
            </p>
          </DialogContent>
        </Dialog>
      </div>
      {pending ? (
        <div
          className="bg-muted/40 border-primary/50 motion-safe:animate-in motion-safe:fade-in mx-4 mb-4 rounded-lg border border-dotted p-4 sm:mx-6"
          role="status"
          aria-live="polite"
        >
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Spinner className="text-primary motion-reduce:animate-none" />
              {evaluation.state === "cancelling"
                ? "Cancelling"
                : rows.some((row) => row.state === "running")
                  ? "Running workflows"
                  : rows.some((row) => row.state === "judging")
                    ? "Judging executions"
                    : "Waiting to start"}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {completed}/{rows.length} finished
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: "Queued",
                icon: Clock3,
                count: rows.filter((row) => row.state === "queued").length,
              },
              {
                label: "Running",
                icon: Play,
                count: rows.filter((row) => row.state === "running").length,
              },
              {
                label: "Judging",
                icon: ScanSearch,
                count: rows.filter((row) => row.state === "judging").length,
              },
            ].map(({ label, icon: Icon, count }) => (
              <div
                key={label}
                data-active={count > 0}
                className="group text-muted-foreground data-[active=true]:text-foreground flex items-center gap-2 text-xs"
              >
                <Icon className="group-data-[active=true]:text-primary size-3.5 shrink-0 motion-safe:group-data-[active=true]:animate-pulse" />
                <span>{label}</span>
                <span className="tabular-nums">{count}</span>
              </div>
            ))}
          </div>
          <Progress
            value={rows.length ? (completed / rows.length) * 100 : 0}
            aria-label="Completed models"
            className="mt-3 [&_[data-slot=progress-indicator]]:duration-700 motion-reduce:[&_[data-slot=progress-indicator]]:transition-none"
          />
        </div>
      ) : null}
      {evaluation.message ? (
        <Alert variant="destructive" className="mx-4 mb-3 w-auto">
          <CircleAlert />
          <AlertDescription>{evaluation.message}</AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {resultColumns.map((name, index) => (
              <TableHead key={name} className={index > 1 ? "text-right" : undefined}>
                {name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.run_name}
              tabIndex={0}
              aria-label={`View ${row.model.label} execution`}
              className="focus-visible:outline-ring cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
              onClick={() => {
                setSelected(row.run_name)
                setTab("judgment")
                setReference(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  setSelected(row.run_name)
                  setTab("judgment")
                  setReference(undefined)
                }
              }}
            >
              <TableCell>
                <span className="flex items-center gap-2 font-medium">
                  <ProviderIcons
                    className="size-4 shrink-0"
                    providers={
                      providerBrands[JSON.stringify([row.model.provider_id, row.model.model_id])] ??
                      []
                    }
                  />
                  <span className="truncate">{row.model.label}</span>
                </span>
              </TableCell>
              <TableCell>
                <Badge
                  className="gap-1.5 capitalize"
                  variant={
                    row.state === "error" ||
                    row.run_status === "Failed" ||
                    row.run_status === "Unacked"
                      ? "destructive"
                      : row.state === "completed"
                        ? "success"
                        : row.state === "running" || row.state === "judging"
                          ? "running"
                          : "pending"
                  }
                >
                  {row.state === "running" || row.state === "judging" ? (
                    <Spinner className="motion-reduce:animate-none" />
                  ) : row.state === "completed" ? (
                    <Check />
                  ) : null}
                  {row.run_status === "Failed" || row.run_status === "Unacked"
                    ? row.run_status
                    : row.state === "error" && row.run_status === "Succeeded"
                      ? "Judge failed"
                      : row.state}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {row.state === "judging" || row.state === "running" ? (
                  <Skeleton className="ml-auto h-4 w-10 motion-reduce:animate-none" />
                ) : (
                  (row.score?.toFixed(1) ?? "—")
                )}
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Charts executions={evaluation.executions} pending={pending} />
      <Sheet
        open={!!execution}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
      >
        <Tabs value={tab} onValueChange={setTab}>
          <TraceInspectorSheet
            title={
              <span className="flex items-center gap-2">
                {execution ? (
                  <ProviderIcons
                    className="size-4 shrink-0"
                    providers={
                      providerBrands[
                        JSON.stringify([execution.model.provider_id, execution.model.model_id])
                      ] ?? []
                    }
                  />
                ) : null}
                {execution?.model.label}
              </span>
            }
            description={
              <span className="flex flex-wrap gap-3">
                {execution?.tokens !== undefined ? (
                  <span>{execution.tokens.toLocaleString()} tokens</span>
                ) : null}
                {execution?.tool_calls !== undefined ? (
                  <span>{execution.tool_calls} tool calls</span>
                ) : null}
                {execution?.duration_seconds !== undefined ? (
                  <span>{formatDurationSeconds(execution.duration_seconds)}</span>
                ) : null}
              </span>
            }
            tabs={
              <TabsList aria-label="Execution details">
                <TabsTrigger value="judgment">Judgment</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
              </TabsList>
            }
          >
            {execution ? (
              <>
                <TabsContent value="judgment" className="m-0 h-full overflow-y-auto px-6 py-4">
                  <div className="max-w-3xl">
                    {execution.message ? (
                      <Alert variant="destructive">
                        <CircleAlert />
                        <AlertDescription>{execution.message}</AlertDescription>
                      </Alert>
                    ) : null}
                    {execution.judgment && execution.score === undefined ? (
                      <p className="text-muted-foreground py-3 text-sm">
                        Score unavailable. Measurements are incomplete.
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
                        <p className="text-sm leading-relaxed">{execution.judgment.summary}</p>
                        <section>
                          <h3 className="mb-2 text-sm font-medium">Findings</h3>
                          <ul className="flex list-disc flex-col gap-3 pl-5 text-sm">
                            {execution.judgment.evidence.map((item, index) => (
                              <li key={index} className="leading-relaxed break-words">
                                {item}
                                {execution.judgment?.references
                                  ?.filter((item) => item.evidence_index === index)
                                  .map((item) => (
                                    <Button
                                      key={`${item.session_id}:${item.message_id}:${item.part_id ?? ""}`}
                                      variant="link"
                                      size="sm"
                                      className="ml-1 h-auto p-0 text-xs"
                                      onClick={() => {
                                        setReference(item)
                                        setTab("transcript")
                                      }}
                                    >
                                      <ScanSearch /> View step
                                    </Button>
                                  ))}
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
                  </div>
                </TabsContent>
                <TabsContent
                  value="transcript"
                  className="m-0 min-h-0 lg:h-full lg:overflow-hidden"
                >
                  {!evidenceReady ? (
                    <p className="text-muted-foreground py-6 text-sm">
                      Transcript available after execution.
                    </p>
                  ) : evidence.isPending ? (
                    <TraceInspectorSkeleton />
                  ) : evidence.isError ? (
                    <Alert variant="destructive">
                      <CircleAlert />
                      <AlertDescription className="flex flex-col items-start gap-3">
                        Could not load transcript.
                        <Button size="sm" variant="outline" onClick={() => evidence.refetch()}>
                          Retry
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : !recordedExecution?.transcript?.length ? (
                    <p className="text-muted-foreground py-6 text-sm">No transcript available</p>
                  ) : (
                    <Transcript sessions={recordedExecution.transcript} reference={reference} />
                  )}
                </TabsContent>
              </>
            ) : null}
          </TraceInspectorSheet>
        </Tabs>
      </Sheet>
    </div>
  )
}

function EvaluationInput({ label, value }: { label?: string; value: JsonValue }) {
  const id = useId()
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((item, index): [string, JsonValue] => [`Item ${index + 1}`, item])
      : Object.entries(value)
    return (
      <FieldSet className="min-w-0">
        {label ? (
          <FieldLegend variant="label" className="wrap-anywhere">
            {label}
          </FieldLegend>
        ) : null}
        {entries.length ? (
          <FieldGroup className={label ? "border-l pl-4" : undefined}>
            {entries.map(([name, item]) => (
              <EvaluationInput key={name} label={name} value={item} />
            ))}
          </FieldGroup>
        ) : (
          <p className="text-muted-foreground text-sm">
            {label ? (Array.isArray(value) ? "No items" : "No fields") : "No inputs"}
          </p>
        )}
      </FieldSet>
    )
  }
  return (
    <Field>
      <FieldLabel htmlFor={id} className="wrap-anywhere">
        {label ?? "Input"}
      </FieldLabel>
      <Textarea
        id={id}
        readOnly
        value={typeof value === "boolean" ? (value ? "true" : "false") : (value ?? "")}
        placeholder={value === null ? "Not provided" : "Empty"}
        rows={1}
        className="bg-muted dark:bg-muted field-sizing-content min-h-0 resize-none rounded-md border-0 p-3 font-mono text-sm focus-visible:ring-0"
      />
    </Field>
  )
}
