"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { getWorkflowEvaluationOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import {
  CircleAlert,
  Download,
  FunctionSquare,
  Check,
  Clock3,
  Play,
  ScanSearch,
  ChevronDown,
} from "lucide-react"
import type { WorkflowEvaluation } from "@/lib/gateway/client"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
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
import { formatDurationSeconds } from "@/lib/format"

const Charts = dynamic(() => import("./charts").then((module) => module.Charts), {
  loading: () => (
    <div className="grid gap-2 p-2 md:grid-cols-2">
      <Skeleton className="h-80 motion-reduce:animate-none" />
      <Skeleton className="h-80 motion-reduce:animate-none" />
    </div>
  ),
  ssr: false,
})

export function Results({
  evaluation,
  workspaceId,
}: {
  evaluation: WorkflowEvaluation
  workspaceId: string
}) {
  const [selected, setSelected] = useState<string>()
  const [tab, setTab] = useState("judgment")
  const [expanded, setExpanded] = useState<string>()
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
      query: { include_transcript: true },
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
        <span className="text-muted-foreground">
          Judge <span className="text-foreground">{evaluation.request.judge.label}</span>
        </span>
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
          className="bg-muted/40 motion-safe:animate-in motion-safe:fade-in mx-4 mb-4 rounded-lg p-4 sm:mx-6"
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
                <span className="ml-auto tabular-nums">{count}</span>
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
            <TableHead>Model</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Score</TableHead>
            <TableHead className="text-right">Correctness</TableHead>
            <TableHead className="text-right">Judge efficiency</TableHead>
            <TableHead className="text-right">Measured efficiency</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.run_name}>
              <TableCell>
                <Button
                  variant="link"
                  onClick={() => {
                    setSelected(row.run_name)
                    setTab("judgment")
                    setExpanded(undefined)
                  }}
                  className="text-foreground max-w-64 justify-start px-0"
                >
                  <span className="truncate">{row.model.label}</span>
                </Button>
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
        <SheetContent className="flex w-full flex-col data-[side=right]:sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{execution?.model.label}</SheetTitle>
            <SheetDescription>{execution?.run_name}</SheetDescription>
          </SheetHeader>
          {execution ? (
            <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 px-4 pb-4">
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
                {!evidenceReady ? (
                  <p className="text-muted-foreground py-6 text-sm">
                    Transcript available after execution.
                  </p>
                ) : evidence.isPending ? (
                  <Skeleton className="mt-3 h-40 motion-reduce:animate-none" />
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
                  <>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-muted-foreground text-xs">
                        {recordedExecution?.transcript?.length ?? 0}{" "}
                        {recordedExecution?.transcript?.length === 1 ? "session" : "sessions"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const url = URL.createObjectURL(
                            new Blob(
                              [
                                JSON.stringify(
                                  {
                                    workflow: evaluation.workflow,
                                    inputs: evaluation.request.inputs,
                                    execution: recordedExecution,
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
                    {tab === "transcript"
                      ? recordedExecution?.transcript?.map((session) => (
                          <Collapsible
                            key={session.session_id}
                            open={expanded === session.session_id}
                            onOpenChange={(open) =>
                              setExpanded(open ? session.session_id : undefined)
                            }
                            className="mb-3 rounded-md border"
                          >
                            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-3 text-left font-mono text-xs">
                              <span className="truncate">
                                {session.session_id} · {session.messages.length} messages
                              </span>
                              <ChevronDown className="size-4 shrink-0" />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              {expanded === session.session_id ? (
                                <pre className="bg-muted overflow-auto p-3 text-xs">
                                  {JSON.stringify(session, null, 2)}
                                </pre>
                              ) : null}
                            </CollapsibleContent>
                          </Collapsible>
                        ))
                      : null}
                  </>
                )}
              </TabsContent>
            </Tabs>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
