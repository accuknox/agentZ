"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Search, MoreHorizontal, Play, Copy, Archive } from "lucide-react"
import { toast } from "sonner"
import { AdministrationState } from "@/components/administration"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  listWorkflowEvaluations,
  getWorkflowEvaluation,
  updateWorkflowEvaluation,
  type Workflow,
  type WorkflowEvaluation,
  type WorkflowEvaluationSummary,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { EvaluationSetup } from "./setup"
import { EvaluationResults } from "./results"

export function Evaluations({
  workspaceId,
  workflow,
  initial,
}: {
  workspaceId: string
  workflow: Workflow
  initial: WorkflowEvaluationSummary[]
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const search = useSearchParams()
  const [filter, setFilter] = useState("")
  const [status, setStatus] = useState("all")
  const [copy, setCopy] = useState<WorkflowEvaluation>()
  const [busy, setBusy] = useState(false)
  const key = ["workflow-evaluations", workspaceId, workflow.agent_name, workflow.workflow_name]
  const listOptions = queryOptions({
    queryKey: key,
    initialData: initial,
    queryFn: async () => {
      const result = await listWorkflowEvaluations({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: workflow.agent_name, workflowName: workflow.workflow_name },
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.state === "queued" || e.state === "running") ? 2500 : false,
  })
  const evaluations = useQuery(listOptions)
  const selectedId = search.get("evaluation")
  function detailOptions(selectedId: string | null) {
    return queryOptions({
      queryKey: [
        "workflow-evaluation",
        workspaceId,
        workflow.agent_name,
        workflow.workflow_name,
        selectedId,
      ],
      enabled: selectedId !== null && selectedId !== "new",
      queryFn: async () => {
        if (!selectedId || selectedId === "new") throw new Error("Choose an evaluation")
        const response = await getWorkflowEvaluation({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          path: {
            agentName: workflow.agent_name,
            workflowName: workflow.workflow_name,
            evaluationId: selectedId,
          },
        })
        if (response.error) throw new Error(response.error.message)
        return response.data
      },
      refetchInterval: (query) =>
        query.state.data?.state === "queued" || query.state.data?.state === "running"
          ? 2500
          : false,
    })
  }
  const detail = useQuery(detailOptions(selectedId))
  const selected = detail.data
  const creating = search.get("evaluation") === "new"
  const filtered = evaluations.data.filter(
    (e) =>
      e.name.toLowerCase().includes(filter.toLowerCase()) &&
      (status === "all" || e.state === status)
  )

  function navigate(id?: string) {
    const params = new URLSearchParams(search)
    if (id) params.set("evaluation", id)
    else params.delete("evaluation")
    router.push(`?${params.toString()}`, { scroll: false })
  }
  async function transition(id: string, action: "launch" | "cancel" | "regrade" | "archive") {
    setBusy(true)
    try {
      const result = await updateWorkflowEvaluation({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: {
          agentName: workflow.agent_name,
          workflowName: workflow.workflow_name,
          evaluationId: id,
        },
        body: { action },
      })
      if (result.error) throw new Error(result.error.message)
      queryClient.setQueryData(detailOptions(id).queryKey, result.data)
      await queryClient.invalidateQueries({ queryKey: listOptions.queryKey, exact: true })
      if (action === "archive") navigate()
      toast.success(
        action === "cancel"
          ? "Cancellation requested"
          : action === "regrade"
            ? "Grading queued"
            : action === "archive"
              ? "Evaluation archived"
              : "Evaluation queued"
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update evaluation")
    } finally {
      setBusy(false)
    }
  }
  if (creating || selected?.state === "draft")
    return (
      <EvaluationSetup
        workflow={workflow}
        workspaceId={workspaceId}
        key={selected?.id ?? "new"}
        previous={selected?.state === "draft" ? selected : copy}
        draftId={selected?.state === "draft" ? selected.id : undefined}
        onCancel={() => navigate()}
        onCreated={(evaluation) => {
          queryClient.setQueryData(detailOptions(evaluation.id).queryKey, evaluation)
          void queryClient.invalidateQueries({ queryKey: listOptions.queryKey, exact: true })
          toast.success(evaluation.state === "draft" ? "Draft saved" : "Evaluation queued")
          navigate(evaluation.id)
        }}
      />
    )
  if (selectedId && !selected)
    return (
      <section className="p-4 sm:p-6">
        <Button variant="ghost" onClick={() => navigate()}>
          Back to evaluations
        </Button>
        <p className="mt-8 text-sm" role="status">
          {detail.error?.message ?? "Loading evaluation…"}
        </p>
        {detail.error && (
          <Button variant="outline" className="mt-4" onClick={() => detail.refetch()}>
            Retry
          </Button>
        )}
      </section>
    )
  if (selected)
    return (
      <EvaluationResults
        evaluation={selected}
        busy={busy}
        onBack={() => navigate()}
        onCancel={() => transition(selected.id, "cancel")}
        onRegrade={() => transition(selected.id, "regrade")}
        onDuplicate={() => {
          setCopy(selected)
          navigate("new")
        }}
      />
    )
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      {evaluations.error && (
        <p
          role="alert"
          className="border-destructive/30 text-destructive rounded-md border p-3 text-sm"
        >
          {evaluations.error.message}{" "}
          <button className="underline" onClick={() => evaluations.refetch()}>
            Retry
          </button>
        </p>
      )}
      {evaluations.data.length === 0 ? (
        <AdministrationState
          kind="empty"
          title="No evaluations yet"
          description="Compare models on the same workflow inputs."
          actions={
            <Button
              size="sm"
              onClick={() => {
                setCopy(undefined)
                navigate("new")
              }}
            >
              <Plus />
              New evaluation
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filter evaluations by status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="all">All statuses</option>
              {["draft", "queued", "running", "completed", "error", "cancelled"].map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
            <div className="relative max-w-xs">
              <Search className="text-muted-foreground absolute top-2.5 left-3 size-4" />
              <Input
                aria-label="Search evaluations"
                placeholder="Find an evaluation…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button
              size="sm"
              className="sm:ml-auto"
              onClick={() => {
                setCopy(undefined)
                navigate("new")
              }}
            >
              <Plus />
              New evaluation
            </Button>
          </div>
          <div className="min-w-0 rounded-md border">
            <Table className="w-full text-left text-sm">
              <TableHeader className="bg-muted/40 text-muted-foreground border-b text-xs">
                <TableRow>
                  <TableHead className="px-4 py-3 font-medium">Evaluation</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Status</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Models</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Attempts</TableHead>
                  <TableHead className="px-4 py-3 font-medium">Created</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => (
                  <TableRow key={e.id} className="hover:bg-muted/30 border-b last:border-0">
                    <TableCell className="min-w-60 px-4 py-3">
                      <button
                        onClick={() => navigate(e.id)}
                        className="text-left font-medium hover:underline"
                      >
                        {e.name}
                      </button>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Cases: {e.case_count} · Attempts per case: {e.repetitions}
                      </p>
                    </TableCell>
                    <TableCell className="px-4">
                      <Badge variant={e.state === "error" ? "destructive" : "secondary"}>
                        {e.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4">{e.model_count}</TableCell>
                    <TableCell className="px-4 tabular-nums">
                      {e.completed_count} / {e.attempt_count}
                    </TableCell>
                    <TableCell className="text-muted-foreground px-4">
                      {new Date(e.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="pr-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${e.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={async () => {
                              setBusy(true)
                              try {
                                const response = await getWorkflowEvaluation({
                                  baseUrl: await getGatewayBaseURL(),
                                  headers: { "X-AgentZ-Workspace-ID": workspaceId },
                                  path: {
                                    agentName: workflow.agent_name,
                                    workflowName: workflow.workflow_name,
                                    evaluationId: e.id,
                                  },
                                })
                                if (response.error) throw new Error(response.error.message)
                                setCopy(response.data)
                                navigate("new")
                              } catch (error) {
                                toast.error(
                                  error instanceof Error
                                    ? error.message
                                    : "Could not open evaluation"
                                )
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            <Copy />
                            Duplicate setup
                          </DropdownMenuItem>
                          {e.state === "draft" && (
                            <DropdownMenuItem onSelect={() => navigate(e.id)}>
                              <Play />
                              Review and run
                            </DropdownMenuItem>
                          )}
                          {e.state !== "running" && e.state !== "queued" && (
                            <DropdownMenuItem onSelect={() => transition(e.id, "archive")}>
                              <Archive />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filtered.length === 0 && (
              <p className="text-muted-foreground p-10 text-center">
                No evaluations match your search.
              </p>
            )}
          </div>
          {evaluations.data.length === 100 && (
            <p className="text-muted-foreground text-xs">Showing the latest 100 evaluations.</p>
          )}
        </>
      )}
    </section>
  )
}
