"use client"

import { useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter, useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Square,
  X,
  XCircle,
} from "lucide-react"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { WorkflowEvaluation } from "@/lib/gateway/client"

const OutputDiff = dynamic(
  () => import("@pierre/diffs/react").then((module) => module.MultiFileDiff),
  { ssr: false }
)

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
})

export function EvaluationResults({
  evaluation: e,
  busy,
  onBack,
  onCancel,
  onRegrade,
  onDuplicate,
}: {
  evaluation: WorkflowEvaluation
  busy: boolean
  onBack: () => void
  onCancel: () => void
  onRegrade: () => void
  onDuplicate: () => void
}) {
  const router = useRouter()
  const search = useSearchParams()
  const [tab, setTab] = useState("output")
  const [page, setPage] = useState(0)
  const evidence = useRef<HTMLElement>(null)
  const invoker = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [explain, setExplain] = useState(false)
  const filter = search.get("filter") ?? "all"
  const query = search.get("q") ?? ""
  const baseline =
    e.request.candidates.find((c) => c.id === search.get("baseline")) ?? e.request.candidates[0]
  const selected = e.attempts.find((a) => a.id === search.get("attempt"))
  const selectedId = selected?.id
  useEffect(() => {
    if (selectedId) {
      evidence.current?.focus({ preventScroll: true })
      evidence.current?.scrollIntoView({ block: "nearest" })
    }
  }, [selectedId])
  const running = e.state === "queued" || e.state === "running"
  const done = e.attempts.filter((a) =>
    ["completed", "failed", "error", "cancelled"].includes(a.state)
  ).length
  const graded = e.attempts.filter((a) => a.score !== undefined).length
  const columns = e.request.candidates.map((candidate) => {
    const attempts = e.attempts.filter((a) => a.candidate_id === candidate.id)
    const scored = attempts.filter((a) => a.score !== undefined)
    const score =
      scored.length === attempts.length && attempts.length
        ? scored.reduce((sum, a) => sum + (a.score ?? 0), 0) / attempts.length
        : undefined
    const measured = attempts.filter((a) => a.tokens !== undefined)
    const tokens = measured.length
      ? measured.reduce((sum, a) => sum + (a.tokens ?? 0), 0) / measured.length
      : undefined
    const cost = measured.length
      ? measured.reduce((sum, a) => sum + (a.cost ?? 0), 0) / measured.length
      : undefined
    const calls = measured.length
      ? measured.reduce((sum, a) => sum + (a.task_calls ?? 0), 0) / measured.length
      : undefined
    const duration = measured.length
      ? measured.reduce((sum, a) => sum + (a.duration_seconds ?? 0), 0) / measured.length
      : undefined
    return {
      candidate,
      attempts,
      score,
      tokens,
      cost,
      calls,
      duration,
      measured: measured.length,
      passed: attempts.filter((a) => a.state === "completed" && a.checks.every((c) => c.passed))
        .length,
    }
  })
  const base = columns.find((c) => c.candidate.id === baseline?.id)
  const cases = e.request.cases.filter((c) => {
    if (
      !`${c.name} ${c.expected} ${JSON.stringify(c.inputs)}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      return false
    const attempts = e.attempts.filter((a) => a.case_id === c.id)
    if (filter === "failures")
      return attempts.some((a) => a.state === "failed" || a.checks.some((check) => !check.passed))
    if (filter === "errors") return attempts.some((a) => a.state === "error")
    if (filter === "inconsistent")
      return columns.some(
        (column) =>
          new Set(
            attempts
              .filter((a) => a.candidate_id === column.candidate.id && a.score !== undefined)
              .map((a) => a.score)
          ).size > 1
      )
    if (filter === "regressions" || filter === "improvements") {
      const baselineScores = attempts.filter(
        (a) => a.candidate_id === baseline?.id && a.score !== undefined
      )
      if (!baselineScores.length) return false
      const mean =
        baselineScores.reduce((sum, a) => sum + (a.score ?? 0), 0) / baselineScores.length
      return columns.some((column) => {
        if (column.candidate.id === baseline?.id) return false
        const scores = attempts.filter(
          (a) => a.candidate_id === column.candidate.id && a.score !== undefined
        )
        if (
          scores.length !== e.request.repetitions ||
          baselineScores.length !== e.request.repetitions
        )
          return false
        const candidateMean = scores.reduce((sum, a) => sum + (a.score ?? 0), 0) / scores.length
        return filter === "regressions" ? candidateMean < mean : candidateMean > mean
      })
    }
    return true
  })
  const selectedCase = e.request.cases.find((c) => c.id === selected?.case_id)
  const reference =
    selected &&
    e.attempts.find(
      (a) =>
        a.case_id === selected.case_id &&
        a.candidate_id === baseline?.id &&
        a.repetition === selected.repetition
    )
  function update(values: Record<string, string | undefined>) {
    const params = new URLSearchParams(search)
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    router.replace(`?${params.toString()}`, { scroll: false })
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(e, null, 2)], { type: "application/json" })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `evaluation-${e.id}.json`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="border-b p-4 sm:px-6">
        <Button variant="ghost" size="sm" className="mb-3 -ml-3" onClick={onBack}>
          <ArrowLeft />
          Evaluations
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold">{e.request.name}</h2>
              <Badge variant={e.state === "error" ? "destructive" : "secondary"}>{e.state}</Badge>
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              Cases: {e.request.cases.length} · Models: {e.request.candidates.length} · Attempts:{" "}
              {e.request.repetitions} · Assessment {e.assessment_revision}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={download}>
              <Download />
              Export
            </Button>
            {running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || e.message === "Cancellation requested"}
                onClick={onCancel}
              >
                <Square />
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={onDuplicate}>
                <Copy />
                Run again
              </Button>
            )}
          </div>
        </div>
        {running && (
          <div className="mt-6 max-w-2xl">
            <div className="mb-2 flex justify-between text-xs">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" />
                {e.message || "Executing and grading"}
              </span>
              <span className="tabular-nums">
                {done} / {e.attempts.length} finished · {graded} scored
              </span>
            </div>
            <Progress value={(100 * done) / Math.max(1, e.attempts.length)} className="h-1.5" />
            <p className="text-muted-foreground mt-2 text-xs">
              Progress is saved. You can leave this page and return later.
            </p>
          </div>
        )}
      </header>
      <div className="space-y-4 p-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground" role="status">
            {e.message ||
              (running
                ? "Results update as attempts finish."
                : graded < e.attempts.length
                  ? "Some attempts could not be scored."
                  : columns.every((column) => column.passed === 0)
                    ? "No model met the success criteria."
                    : "Shared environment with live tools.")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={explain}
            aria-controls="scoring-policy"
            onClick={() => setExplain(!explain)}
          >
            Scoring details
          </Button>
        </div>
        {explain && (
          <div id="scoring-policy" className="rounded-md border p-4 text-sm">
            <h2 className="text-sm font-medium">Scoring policy</h2>
            <p className="text-muted-foreground mt-2 leading-relaxed">
              Failed workflow execution or a failed required output check earns zero. Otherwise, the
              score is quality × 100, reduced by up to{" "}
              {number.format(e.request.policy.efficiency_weight * 100)}% for exceeding resource
              references. Token, task-call, and duration efficiency each contribute equally to that
              reduction. Usage below its reference earns full efficiency credit.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Minimum quality</dt>
                <dd>{e.request.policy.minimum_quality}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reference tokens</dt>
                <dd>{number.format(e.request.policy.token_reference)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reference calls</dt>
                <dd>{e.request.policy.tool_reference}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Reference duration</dt>
                <dd>{e.request.policy.duration_reference}s</dd>
              </div>
            </dl>
            <p className="text-muted-foreground mt-4 text-xs">
              Cost is reported separately. References are chosen for this workflow, not an
              industry-standard weighting. Missing evidence is unscored. These attempts share an
              environment; this is not a controlled model ranking.
            </p>
          </div>
        )}
        <div className="min-w-0 rounded-md border">
          <Table className="w-full text-left text-sm">
            <TableHeader className="bg-muted/30 text-muted-foreground border-b text-xs">
              <TableRow>
                {[
                  "Model",
                  "Score / 100",
                  "Δ baseline",
                  "Passed",
                  "Tokens / attempt",
                  "Task calls",
                  "Reported cost / attempt",
                  "Duration",
                ].map((label) => (
                  <TableHead key={label} className="px-4 py-3 font-medium whitespace-nowrap">
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((c) => (
                <TableRow key={c.candidate.id} className="border-b last:border-0">
                  <TableCell className="min-w-52 px-4 py-3">
                    <p className="font-medium">{c.candidate.label}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {c.candidate.provider_id}
                      {c.candidate.id === baseline?.id ? " · baseline" : ""}
                    </p>
                  </TableCell>
                  <TableCell className="px-4 text-lg font-semibold tabular-nums">
                    <button
                      onClick={() => setExplain(true)}
                      className="hover:text-primary"
                      aria-label={`Explain score for ${c.candidate.label}`}
                    >
                      {c.score === undefined ? "—" : number.format(c.score)}
                    </button>
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.score !== undefined && base?.score !== undefined
                      ? `${c.score - base.score > 0 ? "+" : ""}${number.format(c.score - base.score)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.passed}/{c.attempts.length}
                    {c.measured < c.attempts.length && (
                      <p className="text-muted-foreground mt-1 text-xs whitespace-nowrap">
                        Usage: {c.measured}/{c.attempts.length}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.tokens === undefined ? "—" : number.format(c.tokens)}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.calls === undefined ? "—" : number.format(c.calls)}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.cost === undefined ? "—" : money.format(c.cost)}
                  </TableCell>
                  <TableCell className="px-4 tabular-nums">
                    {c.duration === undefined ? "—" : `${number.format(c.duration)}s`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-xs">
          Usage averages include measured attempts, including failures. Reported cost can be zero
          when provider pricing is unavailable.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-sm font-medium">
            Test cases{" "}
            <span className="text-muted-foreground ml-2 text-sm font-normal">{cases.length}</span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              Baseline
              <select
                className="bg-background text-foreground h-9 max-w-48 rounded-md border px-2 text-sm"
                value={baseline?.id ?? ""}
                onChange={(event) => update({ baseline: event.target.value })}
              >
                {e.request.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
            <select
              aria-label="Filter results"
              value={filter}
              onChange={(event) => {
                setPage(0)
                update({ filter: event.target.value })
              }}
              className="bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="all">All results</option>
              <option value="failures">Failures</option>
              <option value="regressions">Regressions</option>
              <option value="improvements">Improvements</option>
              <option value="inconsistent">Inconsistent</option>
              <option value="errors">Grading errors</option>
            </select>
            <Input
              aria-label="Search test cases"
              value={query}
              placeholder="Search cases"
              className="h-9 w-44"
              onChange={(event) => {
                setPage(0)
                update({ q: event.target.value })
              }}
            />
          </div>
        </div>
        <div
          className={`grid min-w-0 gap-4 ${selected && !expanded ? "xl:grid-cols-[minmax(0,1fr)_minmax(360px,44%)]" : ""}`}
        >
          <div className="min-w-0">
            <div className="max-h-[65vh] overflow-auto rounded-lg border">
              <table className="w-full table-fixed text-left text-sm">
                <TableHeader className="bg-muted sticky top-0 z-20">
                  <TableRow>
                    <TableHead className="bg-muted sticky left-0 z-30 w-44 border-r px-4 py-3 text-xs font-medium sm:w-56">
                      Test case
                    </TableHead>
                    {columns.map((c) => (
                      <TableHead
                        key={c.candidate.id}
                        className="w-64 border-r px-4 py-3 font-medium last:border-r-0"
                      >
                        {c.candidate.label}
                        {c.candidate.id === baseline?.id && (
                          <span className="text-muted-foreground mt-1 block text-xs font-normal">
                            Baseline
                          </span>
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.slice(page * 25, page * 25 + 25).map((c) => (
                    <TableRow key={c.id} className="border-t align-top">
                      <TableCell className="bg-background sticky left-0 z-10 border-r px-4 py-3">
                        <p className="font-medium">{c.name}</p>
                        <pre className="text-muted-foreground mt-2 line-clamp-3 font-mono text-xs break-words whitespace-pre-wrap">
                          {JSON.stringify(c.inputs, null, 2)}
                        </pre>
                      </TableCell>
                      {columns.map((column) => (
                        <TableCell
                          key={column.candidate.id}
                          className="border-r p-2 last:border-r-0"
                        >
                          <div className="space-y-2">
                            {column.attempts
                              .filter((a) => a.case_id === c.id)
                              .map((a) => (
                                <button
                                  key={a.id}
                                  onClick={(event) => {
                                    invoker.current = event.currentTarget
                                    update({ attempt: a.id })
                                  }}
                                  aria-label={`Inspect ${c.name}, ${column.candidate.label}, attempt ${a.repetition}`}
                                  aria-pressed={selected?.id === a.id}
                                  className={`w-full rounded-md border p-3 text-left transition-colors ${selected?.id === a.id ? "border-primary bg-primary/5" : "hover:border-border hover:bg-muted/30 border-transparent"}`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 text-xs">
                                      {a.state === "completed" &&
                                      a.checks.every((check) => check.passed) ? (
                                        <CheckCircle2 className="size-3.5 text-emerald-600" />
                                      ) : a.state === "failed" ||
                                        a.checks.some((check) => !check.passed) ? (
                                        <XCircle className="text-destructive size-3.5" />
                                      ) : a.state === "running" || a.state === "grading" ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : null}
                                      {a.state === "completed"
                                        ? a.checks.every((check) => check.passed)
                                          ? "Passed"
                                          : "Failed"
                                        : a.state}
                                    </span>
                                    <span className="font-semibold tabular-nums">
                                      {a.score === undefined ? "—" : number.format(a.score)}
                                    </span>
                                  </div>
                                  <p className="text-muted-foreground mt-3 line-clamp-3 text-xs leading-relaxed break-words whitespace-pre-wrap">
                                    {a.output || a.message || "Waiting for execution"}
                                  </p>
                                  {e.request.repetitions > 1 && (
                                    <p className="text-muted-foreground mt-3 text-[11px]">
                                      Attempt {a.repetition}
                                    </p>
                                  )}
                                </button>
                              ))}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </table>
              {cases.length === 0 && (
                <p className="text-muted-foreground p-12 text-center text-sm">
                  No cases match these filters.
                </p>
              )}
            </div>
            {cases.length > 25 && (
              <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
                <span>
                  Showing {cases.length ? Math.min(page * 25 + 1, cases.length) : 0}–
                  {Math.min((page + 1) * 25, cases.length)} of {cases.length}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Previous page"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    <ArrowLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Next page"
                    disabled={(page + 1) * 25 >= cases.length}
                    onClick={() => setPage(page + 1)}
                  >
                    <ArrowRight />
                  </Button>
                </div>
              </div>
            )}
          </div>
          {selected && (
            <aside
              ref={evidence}
              tabIndex={-1}
              className="bg-card focus-visible:outline-primary min-w-0 rounded-lg border focus-visible:outline-2"
              aria-label="Attempt evidence"
            >
              <div className="flex items-start justify-between gap-3 border-b p-4">
                <div>
                  <p className="text-muted-foreground text-xs">
                    Attempt {selected.repetition} · {selected.state}
                  </p>
                  <h3 className="mt-1 font-semibold">{selectedCase?.name}</h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {e.request.candidates.find((c) => c.id === selected.candidate_id)?.label}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={expanded ? "Restore comparison layout" : "Expand evidence"}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close evidence"
                    onClick={() => {
                      update({ attempt: undefined })
                      invoker.current?.focus()
                    }}
                  >
                    <X />
                  </Button>
                </div>
              </div>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList
                  variant="line"
                  className="w-full justify-start gap-4 border-b px-4"
                  aria-label="Evidence type"
                >
                  {(["output", "checks", "tools", "usage"] as const).map((value) => (
                    <TabsTrigger key={value} value={value} className="capitalize">
                      {value}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value={tab} className="max-h-[60vh] space-y-5 overflow-auto p-4">
                  {selected.message && (
                    <p role="status" className="bg-muted rounded-md p-3 text-sm">
                      {selected.message}
                    </p>
                  )}
                  {tab === "output" && (
                    <>
                      <div>
                        <h4 className="text-muted-foreground mb-2 text-xs font-semibold">
                          Expected output
                        </h4>
                        <pre className="bg-muted/40 rounded-md p-3 font-sans text-sm break-words whitespace-pre-wrap">
                          {selectedCase?.expected || "Evaluated against the quality rubric"}
                        </pre>
                      </div>
                      {reference && reference.id !== selected.id && (
                        <div>
                          <h4 className="text-muted-foreground mb-2 text-xs font-semibold">
                            Baseline output
                          </h4>
                          <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
                            {reference.output || "No output recorded"}
                          </pre>
                        </div>
                      )}
                      {reference &&
                        reference.id !== selected.id &&
                        reference.output &&
                        selected.output && (
                          <details className="rounded-md border">
                            <summary className="cursor-pointer p-3 text-sm font-medium">
                              Compare output changes
                            </summary>
                            <OutputDiff
                              oldFile={{ name: "baseline.txt", contents: reference.output }}
                              newFile={{ name: "selected.txt", contents: selected.output }}
                              options={{ diffStyle: "unified", overflow: "wrap" }}
                            />
                          </details>
                        )}
                      <div>
                        <h4 className="text-muted-foreground mb-2 text-xs font-semibold">
                          Selected output
                        </h4>
                        <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
                          {selected.output || "No output recorded"}
                        </pre>
                      </div>
                    </>
                  )}
                  {tab === "checks" && (
                    <>
                      {selected.checks.length === 0 ? (
                        <p className="text-muted-foreground text-sm">
                          No grading results recorded yet.
                        </p>
                      ) : (
                        selected.checks.map((check) => (
                          <div key={check.name} className="rounded-md border p-3">
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium">{check.name}</p>
                              <Badge variant={check.passed ? "secondary" : "destructive"}>
                                {check.passed ? "Passed" : "Failed"}
                              </Badge>
                            </div>
                            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                              {check.reason}
                            </p>
                          </div>
                        ))
                      )}
                    </>
                  )}
                  {tab === "tools" && (
                    <>
                      {selected.tools.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No tool calls recorded.</p>
                      ) : (
                        selected.tools.map((tool, index) => (
                          <details key={`${tool.id}-${index}`} className="rounded-md border">
                            <summary className="cursor-pointer p-3 text-sm">
                              <span className="text-muted-foreground mr-2 text-xs">
                                {index + 1}
                              </span>
                              {tool.name}
                              <span className="text-muted-foreground ml-2 text-xs">
                                {tool.state}
                              </span>
                            </summary>
                            <div className="space-y-3 border-t p-3">
                              <pre className="font-mono text-xs break-words whitespace-pre-wrap">
                                {tool.input}
                              </pre>
                              <pre className="text-muted-foreground font-mono text-xs break-words whitespace-pre-wrap">
                                {tool.output}
                              </pre>
                            </div>
                          </details>
                        ))
                      )}
                    </>
                  )}
                  {tab === "usage" && (
                    <dl className="space-y-4 text-sm">
                      {selected.models_used && (
                        <div className="space-y-2">
                          <dt className="text-muted-foreground">
                            Models used, including delegated sessions
                          </dt>
                          <dd className="text-xs break-words">{selected.models_used.join(", ")}</dd>
                        </div>
                      )}
                      {[
                        {
                          label: "Tokens",
                          value:
                            selected.tokens === undefined
                              ? "Unavailable"
                              : number.format(selected.tokens),
                        },
                        { label: "Task tool calls", value: selected.task_calls ?? "Unavailable" },
                        {
                          label: "Workflow protocol calls",
                          value: selected.protocol_calls ?? "Unavailable",
                        },
                        {
                          label: "Reported candidate cost",
                          value:
                            selected.cost === undefined
                              ? "Unavailable"
                              : money.format(selected.cost),
                        },
                        {
                          label: "Duration",
                          value:
                            selected.duration_seconds === undefined
                              ? "Unavailable"
                              : `${number.format(selected.duration_seconds)} seconds`,
                        },
                        {
                          label: "Judge tokens",
                          value: selected.grading
                            ? number.format(selected.grading.tokens)
                            : "Unavailable",
                        },
                        {
                          label: "Reported judge cost",
                          value: selected.grading
                            ? money.format(selected.grading.cost)
                            : "Unavailable",
                        },
                        {
                          label: "Quality",
                          value:
                            selected.quality === undefined
                              ? "Unscored"
                              : number.format(selected.quality * 100) + "%",
                        },
                      ].map((item) => (
                        <div key={item.label} className="flex justify-between gap-4">
                          <dt className="text-muted-foreground">{item.label}</dt>
                          <dd className="font-medium tabular-nums">{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </TabsContent>
              </Tabs>
            </aside>
          )}
        </div>
        {!running && (
          <div className="flex items-center justify-between border-t pt-5">
            <p className="text-muted-foreground text-xs">
              Regrading uses saved evidence and keeps the previous assessment.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || e.state === "cancelled" || e.state === "archived"}
              onClick={onRegrade}
            >
              <RefreshCw />
              Regrade
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
