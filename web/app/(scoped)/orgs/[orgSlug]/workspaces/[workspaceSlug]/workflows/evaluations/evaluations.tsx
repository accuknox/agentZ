"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  FlaskConical,
  Plus,
  Search,
  Clock3,
  MoreHorizontal,
  Play,
  Copy,
  Archive,
} from "lucide-react"
import { toast } from "sonner"
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
      <section className="mx-auto w-full max-w-6xl p-8">
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
    <section className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-8 p-5 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground mb-2 text-xs font-semibold tracking-widest uppercase">
            Model selection
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Find the right model.</h1>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm">
            Compare quality and effort on {workflow.title || workflow.workflow_name}. Every score
            comes with the evidence behind it.
          </p>
        </div>
        <Button
          onClick={() => {
            setCopy(undefined)
            navigate("new")
          }}
        >
          <Plus />
          New evaluation
        </Button>
      </div>
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
        <div className="bg-muted/20 grid flex-1 place-content-center rounded-xl border px-6 py-20 text-center">
          <div className="bg-background mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border shadow-sm">
            <FlaskConical className="text-primary size-6" />
          </div>
          <h2 className="text-xl font-semibold">
            Your workflow. The same cases. Different models.
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md text-sm leading-relaxed">
            Start with a few representative inputs. Compare each model’s output, tool use, tokens,
            and time in one place.
          </p>
          <div className="mt-7 flex justify-center gap-3">
            <Button onClick={() => navigate("new")}>
              Create your first evaluation
              <ArrowUpRight />
            </Button>
          </div>
          <p className="text-muted-foreground mt-5 text-xs">
            Add cases manually or import an existing test set.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Recent evaluations</h2>
              <Badge variant="secondary">{evaluations.data.length}</Badge>
            </div>
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
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-muted-foreground border-b text-xs">
                <tr>
                  <th className="px-5 py-3 font-medium">Evaluation</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Models</th>
                  <th className="px-4 py-3 font-medium">Attempts</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="w-12">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30 border-b last:border-0">
                    <td className="min-w-60 px-5 py-4">
                      <button
                        onClick={() => navigate(e.id)}
                        className="text-left font-medium hover:underline"
                      >
                        {e.name}
                      </button>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {e.case_count} cases · {e.repetitions} attempts per case
                      </p>
                    </td>
                    <td className="px-4">
                      <Badge variant={e.state === "error" ? "destructive" : "secondary"}>
                        {e.state}
                      </Badge>
                    </td>
                    <td className="px-4">{e.model_count}</td>
                    <td className="px-4 tabular-nums">
                      {e.completed_count} / {e.attempt_count}
                    </td>
                    <td className="text-muted-foreground px-4">
                      {new Date(e.created_at).toLocaleDateString()}
                    </td>
                    <td className="pr-3">
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <p className="text-muted-foreground p-10 text-center">
                No evaluations match your search.
              </p>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Clock3 className="size-3.5" />
            Showing the latest 100 evaluations. Running evaluations keep going when you leave this
            page.
          </div>
        </>
      )}
    </section>
  )
}
