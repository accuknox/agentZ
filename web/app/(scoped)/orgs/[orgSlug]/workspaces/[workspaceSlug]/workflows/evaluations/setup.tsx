"use client"

import { useEffect, useState } from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileUp,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  Play,
  Info,
} from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  createWorkflowEvaluation,
  listWorkflowRuns,
  getWorkflowRun,
  type Workflow,
  type WorkflowEvaluation,
  type EvaluationCase,
  type EvaluationCandidate,
  type EvaluationPolicy,
} from "@/lib/gateway/client"
import { zEvaluationCase, zWorkflowEvaluationRequest } from "@/lib/gateway/client/zod.gen"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  buildWorkflowInputObjectSchema,
  workflowScheduleInputsSchema,
} from "@/data/workflow-schedule.schema"
import { createAgentOpencodeClient } from "@/lib/opencode/client"

type CaseDraft = { id: string; name: string; inputs: string; expected: string }
const steps = ["Test cases", "Models", "Success criteria", "Review and run"]

export function EvaluationSetup({
  workflow,
  workspaceId,
  previous,
  draftId,
  onCreated,
  onCancel,
}: {
  workflow: Workflow
  workspaceId: string
  previous?: WorkflowEvaluation
  draftId?: string
  onCreated: (evaluation: WorkflowEvaluation) => void
  onCancel: () => void
}) {
  const [id] = useState(() => draftId ?? crypto.randomUUID())
  const [step, setStep] = useState(draftId ? 3 : 0)
  const [name, setName] = useState(
    previous
      ? draftId
        ? previous.request.name
        : `${previous.request.name} copy`
      : `${workflow.title || workflow.workflow_name} comparison`
  )
  const [cases, setCases] = useState<CaseDraft[]>(
    () =>
      previous?.request.cases.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })) ?? [
        {
          id: crypto.randomUUID(),
          name: "Case 1",
          inputs: JSON.stringify(
            workflow.arbitrary_json?.default_payload ??
              Object.fromEntries(
                Object.entries(workflow.inputs ?? {}).map(([key, input]) => [
                  key,
                  input.default ??
                    (input.type === "boolean" ? false : input.type === "string" ? "" : 0),
                ])
              ),
            null,
            2
          ),
          expected: "",
        },
      ]
  )
  const [candidates, setCandidates] = useState<EvaluationCandidate[]>(
    previous?.request.candidates ?? []
  )
  const [policy, setPolicy] = useState<EvaluationPolicy>(
    previous?.request.policy ?? {
      version: "reference-v1",
      rubric: "",
      minimum_quality: 1,
      token_reference: 1,
      tool_reference: 1,
      duration_reference: 1,
      efficiency_weight: 0,
    }
  )
  const [repetitions, setRepetitions] = useState(previous?.request.repetitions ?? 1)
  const [timeout, setTimeout] = useState(previous?.request.timeout_seconds ?? 600)
  const [liveTools, setLiveTools] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const snapshot = JSON.stringify({ name, cases, candidates, policy, repetitions, timeout })
  const [saved, setSaved] = useState(snapshot)
  const dirty = saved !== snapshot
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  const [search, setSearch] = useState("")
  const models = useQuery(
    queryOptions({
      queryKey: ["evaluation-models", workspaceId, workflow.agent_name],
      queryFn: async () => {
        const client = await createAgentOpencodeClient(workflow.agent_name, workspaceId)
        const response = await client.config.providers()
        if (response.error || !response.data) throw new Error("Could not load this agent’s models")
        return response.data.providers.flatMap((provider) =>
          Object.values(provider.models)
            .filter((model) => model.capabilities.toolcall)
            .flatMap((model) =>
              [undefined, ...Object.keys(model.variants ?? {})].map(
                (variant) =>
                  ({
                    id: `${provider.id}/${model.id}${variant ? `/${variant}` : ""}`,
                    label: `${model.name}${variant ? ` · ${variant}` : ""}`,
                    provider_id: provider.id,
                    model_id: model.id,
                    variant,
                  }) satisfies EvaluationCandidate
              )
            )
        )
      },
    })
  )

  function readCases(): EvaluationCase[] {
    return cases.map((c) => {
      const result = zEvaluationCase.parse({ ...c, inputs: JSON.parse(c.inputs) })
      if (!workflow.arbitrary_json)
        buildWorkflowInputObjectSchema(workflow.inputs ?? {}).parse(result.inputs)
      return result
    })
  }
  function next() {
    setError("")
    try {
      if (step === 0) readCases()
      if (cases.length * candidates.length * repetitions > 1000)
        throw new Error("Use at most 1,000 executions per evaluation.")
      if (step === 1 && candidates.length === 0) throw new Error("Select at least one model.")
      if (step === 2 && policy.rubric && !policy.judge)
        throw new Error("Choose a judge for the quality rubric.")
      if (step === 2 && !policy.rubric && cases.some((c) => !c.expected.trim()))
        throw new Error("Give each case an expected output, or add a quality rubric.")
      setStep(step + 1)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Review the highlighted settings.")
    }
  }
  async function submit(draft: boolean) {
    setError("")
    setBusy(true)
    try {
      const body = zWorkflowEvaluationRequest.parse({
        id,
        name,
        cases: readCases(),
        candidates,
        repetitions,
        timeout_seconds: timeout,
        policy,
        draft,
        live_tools: liveTools,
      })
      const result = await createWorkflowEvaluation({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: workflow.agent_name, workflowName: workflow.workflow_name },
        body,
      })
      if (result.error)
        throw new Error(
          [
            result.error.message,
            ...(result.error.errors?.map((field) => `${field.field}: ${field.message}`) ?? []),
          ].join("\n")
        )
      setSaved(snapshot)
      onCreated(result.data)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save evaluation.")
    } finally {
      setBusy(false)
    }
  }
  async function importRuns() {
    setError("")
    try {
      const response = await listWorkflowRuns({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: workflow.agent_name, workflowName: workflow.workflow_name },
        query: { limit: 20 },
      })
      if (response.error) throw new Error(response.error.message)
      const imported = await Promise.all(
        response.data.workflow_runs.map(async (run) => {
          const detail = await getWorkflowRun({
            baseUrl: await getGatewayBaseURL(),
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: {
              agentName: workflow.agent_name,
              workflowName: workflow.workflow_name,
              runName: run.name,
            },
          })
          if (detail.error) throw new Error(detail.error.message)
          return zEvaluationCase.parse({
            id: crypto.randomUUID(),
            name: run.name,
            inputs: detail.data.inputs,
            expected: "",
          })
        })
      )
      if (!imported.length) throw new Error("This workflow has no past runs yet.")
      setCases(imported.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })))
      toast.success(`Imported ${imported.length} inputs. Add expected outputs or a quality rubric.`)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not import past runs.")
    }
  }
  async function importCases(file: File) {
    try {
      let rows: unknown
      if (file.name.toLowerCase().endsWith(".csv")) {
        const { read, utils } = await import("xlsx")
        const book = read(await file.text(), { type: "string", raw: true })
        const sheetName = book.SheetNames[0]
        if (!sheetName) throw new Error("CSV is empty")
        const sheet = book.Sheets[sheetName]
        if (!sheet) throw new Error("CSV sheet is missing")
        const csv = z
          .array(
            z.object({ name: z.string(), inputs: z.string(), expected: z.string().default("") })
          )
          .parse(utils.sheet_to_json(sheet, { defval: "" }))
        rows = csv.map((row) => ({ ...row, inputs: JSON.parse(row.inputs) }))
      } else {
        rows = JSON.parse(await file.text())
      }
      const imported = z
        .array(zEvaluationCase.extend({ id: z.string().optional() }))
        .min(1)
        .max(1000)
        .parse(rows)
        .map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() }))
      setCases(imported.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })))
      toast.success(`${imported.length} test cases imported`)
    } catch {
      setError(
        "Use JSON cases or CSV columns named name, inputs, expected. Inputs must contain a JSON object. Existing cases have not changed."
      )
    }
  }
  return (
    <section className="mx-auto w-full max-w-6xl p-5 sm:p-8">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (!dirty || window.confirm("Discard unsaved evaluation changes?")) onCancel()
        }}
        className="mb-5 -ml-3"
      >
        <ArrowLeft />
        Evaluations
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
            {draftId ? "Edit draft" : "New evaluation"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Compare models on real cases.
          </h1>
        </div>
        <Badge variant="outline">{workflow.workflow_name}</Badge>
      </div>
      <ol aria-label="Evaluation setup" className="my-8 grid grid-cols-4 border-b">
        {steps.map((label, index) => (
          <li key={label}>
            <button
              disabled={index > step}
              onClick={() => setStep(index)}
              aria-current={step === index ? "step" : undefined}
              className={`flex w-full items-center gap-2 border-b-2 py-4 text-left text-xs sm:text-sm ${step === index ? "border-primary font-semibold" : "text-muted-foreground border-transparent"}`}
            >
              <span
                className={`grid size-6 shrink-0 place-content-center rounded-full text-xs ${step === index ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              >
                {index < step ? <Check className="size-3" /> : index + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          {step === 0 && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Start with representative cases</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Use realistic inputs. Include the difficult cases your workflow needs to handle.
                  </p>
                </div>
                <Button variant="outline" onClick={importRuns}>
                  Use past runs
                </Button>
                <label className="hover:bg-muted inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm whitespace-nowrap">
                  <FileUp className="size-4" />
                  Import CSV or JSON
                  <input
                    type="file"
                    accept="application/json,text/csv,.json,.csv"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void importCases(file)
                    }}
                  />
                </label>
              </div>
              {cases.map((c, index) => (
                <div key={c.id} className="bg-card rounded-lg border p-5">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <Input
                      aria-label={`Case ${index + 1} name`}
                      value={c.name}
                      onChange={(e) =>
                        setCases(
                          cases.map((item) =>
                            item.id === c.id ? { ...item, name: e.target.value } : item
                          )
                        )
                      }
                      className="focus-visible:border-input border-transparent font-medium shadow-none"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${c.name}`}
                      disabled={cases.length === 1}
                      onClick={() => setCases(cases.filter((item) => item.id !== c.id))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <CaseInputs
                        workflow={workflow}
                        caseId={c.id}
                        value={c.inputs}
                        onChange={(inputs) =>
                          setCases(
                            cases.map((item) => (item.id === c.id ? { ...item, inputs } : item))
                          )
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor={`${c.id}-expected`}>Expected output</Label>
                      <Textarea
                        id={`${c.id}-expected`}
                        placeholder="The exact expected answer, or leave blank when using a quality rubric."
                        value={c.expected}
                        onChange={(e) =>
                          setCases(
                            cases.map((item) =>
                              item.id === c.id ? { ...item, expected: e.target.value } : item
                            )
                          )
                        }
                        className="mt-2 min-h-36"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  setCases([
                    ...cases,
                    {
                      id: crypto.randomUUID(),
                      name: `Case ${cases.length + 1}`,
                      inputs: "{}",
                      expected: "",
                    },
                  ])
                }
              >
                <Plus />
                Add test case
              </Button>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">Choose the models to compare</h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Available models come from this agent’s configuration. The first model is your
                  comparison baseline.
                </p>
              </div>
              <div className="relative">
                <Search className="text-muted-foreground absolute top-3 left-3 size-4" />
                <Input
                  aria-label="Find models"
                  placeholder="Search models or providers"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {models.isPending && (
                <p role="status" className="text-muted-foreground text-sm">
                  Loading available models…
                </p>
              )}
              {models.error && (
                <p role="alert" className="text-destructive text-sm">
                  {models.error.message}{" "}
                  <button className="underline" onClick={() => models.refetch()}>
                    Retry
                  </button>
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {models.data
                  ?.filter((model) =>
                    `${model.label} ${model.provider_id}`
                      .toLowerCase()
                      .includes(search.toLowerCase())
                  )
                  .map((model) => {
                    const selected = candidates.some((c) => c.id === model.id)
                    return (
                      <label
                        key={model.id}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary mt-1"
                          checked={selected}
                          onChange={() =>
                            setCandidates(
                              selected
                                ? candidates.filter((c) => c.id !== model.id)
                                : [...candidates, model]
                            )
                          }
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{model.label}</span>
                          <span className="text-muted-foreground mt-1 block text-xs break-all">
                            {model.provider_id} / {model.model_id}
                          </span>
                          {candidates[0]?.id === model.id && (
                            <Badge variant="secondary" className="mt-2">
                              Baseline
                            </Badge>
                          )}
                        </span>
                      </label>
                    )
                  })}
              </div>
              {models.data?.length === 0 && (
                <p className="text-muted-foreground rounded-lg border p-8 text-center">
                  This agent has no models with tool support. Configure its inference providers
                  first.
                </p>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Define what a good run looks like</h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Successful execution is required. Expected outputs use exact text matching,
                  ignoring surrounding whitespace.
                </p>
              </div>
              <div>
                <Label htmlFor="rubric">Quality rubric</Label>
                <Textarea
                  id="rubric"
                  className="mt-2 min-h-32"
                  placeholder="Describe correctness, completeness, and the quality bar. Leave blank to use expected-output checks only."
                  value={policy.rubric}
                  onChange={(e) => setPolicy({ ...policy, rubric: e.target.value })}
                />
              </div>
              {policy.rubric && (
                <div>
                  <Label htmlFor="judge">Judge model</Label>
                  <select
                    id="judge"
                    className="bg-background mt-2 h-10 w-full rounded-md border px-3 text-sm"
                    value={policy.judge?.id ?? ""}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        judge: models.data?.find((model) => model.id === e.target.value),
                      })
                    }
                  >
                    <option value="">Choose a judge</option>
                    {models.data?.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} · {model.provider_id}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="rounded-lg border p-5">
                <h3 className="font-medium">Quality and resource efficiency</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  Set resource references from a known good run. Savings can reduce the resource
                  penalty; they cannot rescue a failed correctness check. These are
                  workflow-specific settings.
                </p>
                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="quality">Minimum quality · 0 to 1</Label>
                    <Input
                      id="quality"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={policy.minimum_quality}
                      onChange={(e) =>
                        setPolicy({ ...policy, minimum_quality: e.target.valueAsNumber })
                      }
                      className="mt-2"
                    />
                  </div>
                  <div>
                    <Label htmlFor="efficiency">Maximum efficiency penalty · 0 to 1</Label>
                    <Input
                      id="efficiency"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={policy.efficiency_weight}
                      onChange={(e) =>
                        setPolicy({ ...policy, efficiency_weight: e.target.valueAsNumber })
                      }
                      className="mt-2"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tokens">Reference tokens</Label>
                    <Input
                      id="tokens"
                      type="number"
                      min={1}
                      value={policy.token_reference}
                      onChange={(e) =>
                        setPolicy({ ...policy, token_reference: e.target.valueAsNumber })
                      }
                      className="mt-2"
                    />
                  </div>
                  <div>
                    <Label htmlFor="tools">Reference task tool calls</Label>
                    <Input
                      id="tools"
                      type="number"
                      min={1}
                      value={policy.tool_reference}
                      onChange={(e) =>
                        setPolicy({ ...policy, tool_reference: e.target.valueAsNumber })
                      }
                      className="mt-2"
                    />
                  </div>
                  <div>
                    <Label htmlFor="duration">Reference time · seconds</Label>
                    <Input
                      id="duration"
                      type="number"
                      min={1}
                      value={policy.duration_reference}
                      onChange={(e) =>
                        setPolicy({ ...policy, duration_reference: e.target.valueAsNumber })
                      }
                      className="mt-2"
                    />
                  </div>
                </div>
                <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
                  With zero efficiency penalty, this pilot measures quality only. Calibrate
                  references before using the composite score to select a model.
                </p>
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Review before running</h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  The workflow definition, cases, models, and grading policy are frozen at launch.
                </p>
              </div>
              <div>
                <Label htmlFor="name">Evaluation name</Label>
                <Input
                  id="name"
                  className="mt-2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="repetitions">Attempts per case and model</Label>
                  <Input
                    id="repetitions"
                    className="mt-2"
                    type="number"
                    min={1}
                    max={10}
                    value={repetitions}
                    onChange={(e) => setRepetitions(e.target.valueAsNumber)}
                  />
                </div>
                <div>
                  <Label htmlFor="timeout">Timeout per attempt · seconds</Label>
                  <Input
                    id="timeout"
                    className="mt-2"
                    type="number"
                    min={30}
                    max={3600}
                    value={timeout}
                    onChange={(e) => setTimeout(e.target.valueAsNumber)}
                  />
                </div>
              </div>
              <div className="bg-muted/30 rounded-lg border p-5">
                <div className="flex gap-3">
                  <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div className="space-y-2 text-sm">
                    <p className="font-medium">
                      Uses this agent’s existing environment and live tools
                    </p>
                    <p className="text-muted-foreground leading-relaxed">
                      Each attempt gets a new session, but files and external services are shared.
                      Tool actions can change them. Results are exploratory because the environment
                      is not reset between attempts.
                    </p>
                    <p className="text-muted-foreground">
                      The selected model controls the workflow runner. Delegated agents retain their
                      configured models and their usage is included. Cost is not estimated yet.
                      Model execution and rubric judging may incur charges.
                    </p>
                  </div>
                </div>
                <label className="mt-5 flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={liveTools}
                    onChange={(e) => setLiveTools(e.target.checked)}
                    className="accent-primary mt-1"
                  />
                  I have reviewed these cases and their live tool actions.
                </label>
              </div>
            </div>
          )}
          {error && (
            <pre
              role="alert"
              className="border-destructive/30 bg-destructive/5 text-destructive mt-5 rounded-md border p-4 font-sans text-sm whitespace-pre-wrap"
            >
              {error}
            </pre>
          )}
          <div className="mt-8 flex items-center justify-between border-t pt-5">
            <Button
              variant="ghost"
              onClick={() => (step > 0 ? setStep(step - 1) : onCancel())}
              disabled={busy}
            >
              <ArrowLeft />
              {step > 0 ? "Back" : "Cancel"}
            </Button>
            <div className="flex gap-2">
              {step === 3 ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => submit(true)}>
                    <Save />
                    Save draft
                  </Button>
                  <Button disabled={busy || !liveTools} onClick={() => submit(false)}>
                    {busy ? <Loader2 className="animate-spin" /> : <Play />}Run evaluation
                  </Button>
                </>
              ) : (
                <Button onClick={next}>
                  Continue
                  <ArrowRight />
                </Button>
              )}
            </div>
          </div>
        </div>
        <aside className="bg-muted/20 h-fit rounded-lg border p-5 lg:sticky lg:top-6">
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Comparison setup
          </p>
          <h3 className="mt-3 font-medium">{workflow.title || workflow.workflow_name}</h3>
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Test cases</dt>
              <dd className="tabular-nums">{cases.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Models</dt>
              <dd className="tabular-nums">{candidates.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Attempts each</dt>
              <dd className="tabular-nums">{repetitions}</dd>
            </div>
            <div className="flex justify-between border-t pt-3 font-medium">
              <dt>Workflow executions</dt>
              <dd className="tabular-nums">{cases.length * candidates.length * repetitions}</dd>
            </div>
          </dl>
          {candidates.length > 0 && (
            <div className="mt-5 space-y-2 border-t pt-4">
              {candidates.map((candidate, index) => (
                <p key={candidate.id} className="text-muted-foreground text-xs">
                  {candidate.label}
                  {index === 0 ? " · baseline" : ""}
                </p>
              ))}
            </div>
          )}
          <p className="text-muted-foreground mt-5 text-xs leading-relaxed">
            You can leave a running evaluation and return later. Its progress is saved on the
            server.
          </p>
        </aside>
      </div>
    </section>
  )
}

function CaseInputs({
  workflow,
  caseId,
  value,
  onChange,
}: {
  workflow: Workflow
  caseId: string
  value: string
  onChange: (value: string) => void
}) {
  const [json, setJSON] = useState(workflow.arbitrary_json !== undefined)
  let values: z.output<typeof workflowScheduleInputsSchema> | undefined
  try {
    values = workflowScheduleInputsSchema.parse(JSON.parse(value))
  } catch {
    // Keep malformed imports editable as JSON; never replace their contents.
  }
  if (json || !values || !workflow.inputs)
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${caseId}-inputs`}>Workflow inputs · JSON</Label>
          {!workflow.arbitrary_json && values && (
            <Button size="sm" variant="ghost" onClick={() => setJSON(false)}>
              Use fields
            </Button>
          )}
        </div>
        <Textarea
          id={`${caseId}-inputs`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-2 min-h-36 font-mono text-xs"
          spellCheck={false}
        />
      </div>
    )
  const fields = values
  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">Workflow inputs</legend>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Workflow inputs</p>
        <Button size="sm" variant="ghost" onClick={() => setJSON(true)}>
          Edit JSON
        </Button>
      </div>
      {Object.entries(workflow.inputs).map(([name, input]) => {
        const current = fields[name]
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={`${caseId}-${name}`}>
              {name}
              {input.required ? " *" : ""}
            </Label>
            {input.description && (
              <p className="text-muted-foreground text-xs">{input.description}</p>
            )}
            {input.enum ? (
              <select
                id={`${caseId}-${name}`}
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={JSON.stringify(current) ?? ""}
                onChange={(event) => {
                  const selected = input.enum?.find(
                    (choice) => JSON.stringify(choice) === event.target.value
                  )
                  onChange(JSON.stringify({ ...values, [name]: selected }, null, 2))
                }}
              >
                <option value="">Choose a value</option>
                {input.enum.map((choice) => (
                  <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                    {choice.toString()}
                  </option>
                ))}
              </select>
            ) : input.type === "boolean" ? (
              <select
                id={`${caseId}-${name}`}
                className="bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={JSON.stringify(current) ?? ""}
                onChange={(event) =>
                  onChange(
                    JSON.stringify(
                      {
                        ...values,
                        [name]:
                          event.target.value === "" ? undefined : event.target.value === "true",
                      },
                      null,
                      2
                    )
                  )
                }
              >
                <option value="">Choose a value</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            ) : (
              <Input
                id={`${caseId}-${name}`}
                type={input.type === "string" ? "text" : "number"}
                value={current?.toString() ?? ""}
                min={input.minimum}
                max={input.maximum}
                step={input.type === "integer" ? 1 : "any"}
                minLength={input.minLength}
                maxLength={input.maxLength}
                required={input.required}
                onChange={(event) =>
                  onChange(
                    JSON.stringify(
                      {
                        ...values,
                        [name]:
                          input.type === "string"
                            ? event.target.value
                            : event.target.value === ""
                              ? undefined
                              : event.target.valueAsNumber,
                      },
                      null,
                      2
                    )
                  )
                }
              />
            )}
          </div>
        )
      })}
    </fieldset>
  )
}
