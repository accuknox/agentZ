"use client"

import { useEffect, useRef, useState } from "react"
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
import { FieldError } from "@/components/ui/field"
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
  workflowInputDefaultValues,
} from "@/data/workflow-schedule.schema"
import { createAgentOpencodeClient } from "@/lib/opencode/client"

type CaseDraft = { id: string; name: string; inputs: string; expected: string }
const steps = ["Test cases", "Models", "Success criteria", "Review and run"]

const validationError: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string")
        return issue.minimum === 1
          ? "This field is required."
          : `Use at least ${issue.minimum} characters.`
      if (issue.origin === "array") return `Select at least ${issue.minimum} items.`
      return `Must be at least ${issue.minimum}.`
    case "too_big":
      if (issue.origin === "string") return `Use at most ${issue.maximum} characters.`
      if (issue.origin === "array") return `Select at most ${issue.maximum} items.`
      return `Must be at most ${issue.maximum}.`
    case "invalid_type":
      return issue.expected === "int" ? "Enter a whole number." : "Enter a valid value."
    default:
      return undefined
  }
}

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
              workflowInputDefaultValues(workflow.inputs ?? {}),
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
  const [validated, setValidated] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const form = useRef<HTMLElement>(null)
  useEffect(() => {
    const target = error
      ? form.current?.querySelector<HTMLElement>("[data-evaluation-error]")
      : (form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        form.current?.querySelector<HTMLElement>("h3"))
    const details = target?.closest("details")
    if (details) details.open = true
    target?.focus()
  }, [step, focusRequest, error])
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

  function validate(targetStep: number) {
    const errors: Record<string, { message: string }[]> = {}
    const parsedCases: EvaluationCase[] = []
    if (targetStep === 0) {
      for (const c of cases) {
        let inputs: unknown
        try {
          inputs = JSON.parse(c.inputs)
        } catch {
          errors[`${c.id}-inputs`] = [{ message: "Enter valid JSON." }]
          continue
        }
        const result = zEvaluationCase.safeParse({ ...c, inputs }, { error: validationError })
        if (!result.success) {
          for (const issue of result.error.issues) {
            const key = `${c.id}-${issue.path.slice(0, 1).join("") || "inputs"}`
            errors[key] = [...(errors[key] ?? []), issue]
          }
        }
        if (result.success) parsedCases.push(result.data)
        if (workflow.arbitrary_json) continue
        const contract = buildWorkflowInputObjectSchema(workflow.inputs ?? {}).safeParse(inputs)
        if (!contract.success) {
          for (const issue of contract.error.issues) {
            const key = `${c.id}-inputs${issue.path.length ? `-${issue.path.slice(0, 1).join("")}` : ""}`
            errors[key] = [...(errors[key] ?? []), issue]
          }
        }
      }
      if (cases.length > 1000) errors.cases = [{ message: "Use at most 1,000 test cases." }]
      return { errors, cases: parsedCases }
    }
    const request = { name, candidates, policy, repetitions, timeout_seconds: timeout }
    const schema = [
      zWorkflowEvaluationRequest.pick({ candidates: true }),
      zWorkflowEvaluationRequest.pick({ policy: true }),
      zWorkflowEvaluationRequest.pick({ name: true, repetitions: true, timeout_seconds: true }),
    ][targetStep - 1]
    const result = schema?.safeParse(request, { error: validationError })
    if (result && !result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path.join("-")
        errors[key] = [...(errors[key] ?? []), issue]
      }
    }
    if (targetStep === 1 && candidates.length === 0)
      errors.candidates = [{ message: "Select at least one model." }]
    if (targetStep === 2 && policy.rubric.trim() && !policy.judge)
      errors["policy-judge"] = [{ message: "Choose a judge model." }]
    if (targetStep === 2 && !policy.rubric.trim() && cases.some((c) => !c.expected.trim()))
      errors["policy-rubric"] = [
        { message: "Add a rubric, or give every test case an expected output." },
      ]
    if (targetStep === 3 && cases.length * candidates.length * repetitions > 1000)
      errors.repetitions = [
        { message: "Reduce attempts, cases or models to stay within 1,000 executions." },
      ]
    return { errors, cases: parsedCases }
  }
  const validation = validate(step)
  const fieldErrors = validated ? validation.errors : {}
  function next() {
    setError("")
    if (Object.keys(validation.errors).length) {
      setValidated(true)
      setFocusRequest((request) => request + 1)
      return
    }
    setValidated(false)
    setStep(step + 1)
  }
  async function submit(draft: boolean) {
    setError("")
    let parsedCases: EvaluationCase[] = []
    for (let index = 0; index < steps.length; index++) {
      const result = validate(index)
      if (Object.keys(result.errors).length) {
        setStep(index)
        setValidated(true)
        setFocusRequest((request) => request + 1)
        return
      }
      if (index === 0) parsedCases = result.cases
    }
    setBusy(true)
    try {
      const result = await createWorkflowEvaluation({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName: workflow.agent_name, workflowName: workflow.workflow_name },
        body: {
          id,
          name,
          cases: parsedCases,
          candidates,
          repetitions,
          timeout_seconds: timeout,
          policy,
          draft,
          live_tools: liveTools,
        },
      })
      if (result.error) {
        setError(
          [
            result.error.message,
            ...(result.error.errors?.map((field) => field.message) ?? []),
          ].join(" ")
        )
        return
      }
      setSaved(snapshot)
      onCreated(result.data)
    } catch {
      setError("Could not save the evaluation. Try again.")
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
      if (response.error) {
        setError(response.error.message)
        return
      }
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
      if (!imported.length) {
        setError("This workflow has no past runs yet.")
        return
      }
      setError("")
      setValidated(false)
      setCases(imported.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })))
      toast.success(`Imported ${imported.length} inputs. Add expected outputs or a quality rubric.`)
    } catch (error) {
      setError(
        error instanceof z.ZodError
          ? "Some past runs have unsupported inputs."
          : "Could not import past runs. Try again."
      )
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
      setError("")
      setValidated(false)
      setCases(imported.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })))
      toast.success(`${imported.length} test cases imported`)
    } catch {
      setError(
        "Use a JSON array of cases or CSV columns named name, inputs, expected. Inputs must be valid JSON."
      )
    }
  }
  return (
    <section ref={form} className="w-full max-w-5xl min-w-0 p-4 sm:p-6">
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
      <h2 className="text-base font-semibold">{draftId ? "Edit draft" : "New evaluation"}</h2>
      <ol aria-label="Evaluation setup" className="my-4 flex gap-4 overflow-x-auto border-b">
        {steps.map((label, index) => (
          <li key={label} className="shrink-0">
            <button
              disabled={index > step}
              onClick={() => {
                setStep(index)
                setValidated(false)
                setError("")
              }}
              aria-current={step === index ? "step" : undefined}
              className={`flex w-full items-center gap-2 border-b-2 py-3 text-left text-sm ${step === index ? "border-primary font-semibold" : "text-muted-foreground border-transparent"}`}
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
      <div className="min-w-0">
        {error && (
          <p
            role="alert"
            data-evaluation-error
            tabIndex={-1}
            className="border-destructive/30 bg-destructive/5 text-destructive mt-5 rounded-md border p-4 text-sm"
          >
            {error}
          </p>
        )}
        {step === 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 tabIndex={-1} className="text-sm font-medium outline-none">
                  Test cases
                </h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Add inputs and an optional expected output.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={importRuns}>
                  Use past runs
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="focus-within:ring-ring focus-within:ring-2"
                >
                  <label className="cursor-pointer">
                    <FileUp className="size-4" />
                    Import cases
                    <input
                      type="file"
                      accept="application/json,text/csv,.json,.csv"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void importCases(file)
                        e.target.value = ""
                      }}
                    />
                  </label>
                </Button>
              </div>
            </div>
            <FieldError errors={fieldErrors.cases} />
            {cases.map((c, index) => (
              <div key={c.id} className="rounded-md border p-4">
                <div className="mb-4 flex items-center gap-3">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <Input
                    id={`${c.id}-name`}
                    aria-label={`Case ${index + 1} name`}
                    aria-invalid={!!fieldErrors[`${c.id}-name`]}
                    aria-describedby={`${c.id}-name-error`}
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
                <FieldError id={`${c.id}-name-error`} errors={fieldErrors[`${c.id}-name`]} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <CaseInputs
                      workflow={workflow}
                      caseId={c.id}
                      errors={fieldErrors}
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
                      aria-invalid={!!fieldErrors[`${c.id}-expected`]}
                      aria-describedby={`${c.id}-expected-error`}
                      placeholder="Exact answer, or leave blank to use a rubric."
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
                    <FieldError
                      id={`${c.id}-expected-error`}
                      errors={fieldErrors[`${c.id}-expected`]}
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
                    inputs: JSON.stringify(
                      workflow.arbitrary_json?.default_payload ??
                        workflowInputDefaultValues(workflow.inputs ?? {}),
                      null,
                      2
                    ),
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
          <div className="space-y-4">
            <div>
              <h3 tabIndex={-1} className="text-sm font-medium outline-none">
                Models
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                The first selected model is the baseline.
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
            <fieldset
              id="candidates"
              tabIndex={-1}
              aria-invalid={!!fieldErrors.candidates}
              aria-describedby="candidates-error"
              className="grid gap-2 sm:grid-cols-2"
            >
              <legend className="sr-only">Models</legend>
              {models.data
                ?.filter((model) =>
                  `${model.label} ${model.provider_id}`.toLowerCase().includes(search.toLowerCase())
                )
                .map((model) => {
                  const selected = candidates.some((c) => c.id === model.id)
                  return (
                    <label
                      key={model.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
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
            </fieldset>
            <FieldError id="candidates-error" errors={fieldErrors.candidates} />
            {models.data &&
              models.data.length > 0 &&
              !models.data.some((model) =>
                `${model.label} ${model.provider_id}`.toLowerCase().includes(search.toLowerCase())
              ) && (
                <p className="text-muted-foreground py-6 text-sm">No models match your search.</p>
              )}
            {models.data?.length === 0 && (
              <p className="text-muted-foreground py-6 text-sm">
                This agent has no models with tool support. Configure its inference providers first.
              </p>
            )}
          </div>
        )}
        {step === 2 && (
          <div className="space-y-6">
            <div>
              <h3 tabIndex={-1} className="text-sm font-medium outline-none">
                Success criteria
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Expected outputs must match exactly, ignoring surrounding whitespace.
              </p>
            </div>
            <div>
              <Label htmlFor="policy-rubric">Quality rubric</Label>
              <Textarea
                id="policy-rubric"
                aria-invalid={!!fieldErrors["policy-rubric"]}
                aria-describedby="policy-rubric-error"
                className="mt-2 min-h-32"
                placeholder="Describe how to judge a successful output."
                value={policy.rubric}
                onChange={(e) => setPolicy({ ...policy, rubric: e.target.value })}
              />
              <FieldError id="policy-rubric-error" errors={fieldErrors["policy-rubric"]} />
            </div>
            {policy.rubric && (
              <div>
                <Label htmlFor="policy-judge">Judge model</Label>
                <select
                  id="policy-judge"
                  aria-invalid={!!fieldErrors["policy-judge"]}
                  aria-describedby="policy-judge-error"
                  className="bg-background aria-invalid:border-destructive mt-2 h-9 w-full rounded-md border px-3 text-sm"
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
                <FieldError id="policy-judge-error" errors={fieldErrors["policy-judge"]} />
              </div>
            )}
            <details className="rounded-md border p-4">
              <summary className="cursor-pointer text-sm font-medium">Scoring settings</summary>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                Set references from a known good run. Failed output checks always score zero.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="policy-minimum_quality">Minimum quality · 0 to 1</Label>
                  <Input
                    id="policy-minimum_quality"
                    aria-invalid={!!fieldErrors["policy-minimum_quality"]}
                    aria-describedby="policy-minimum_quality-error"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={Number.isNaN(policy.minimum_quality) ? "" : policy.minimum_quality}
                    onChange={(e) =>
                      setPolicy({ ...policy, minimum_quality: e.target.valueAsNumber })
                    }
                    className="mt-2"
                  />
                  <FieldError
                    id="policy-minimum_quality-error"
                    errors={fieldErrors["policy-minimum_quality"]}
                  />
                </div>
                <div>
                  <Label htmlFor="policy-efficiency_weight">
                    Maximum efficiency penalty · 0 to 1
                  </Label>
                  <Input
                    id="policy-efficiency_weight"
                    aria-invalid={!!fieldErrors["policy-efficiency_weight"]}
                    aria-describedby="policy-efficiency_weight-error"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={Number.isNaN(policy.efficiency_weight) ? "" : policy.efficiency_weight}
                    onChange={(e) =>
                      setPolicy({ ...policy, efficiency_weight: e.target.valueAsNumber })
                    }
                    className="mt-2"
                  />
                  <FieldError
                    id="policy-efficiency_weight-error"
                    errors={fieldErrors["policy-efficiency_weight"]}
                  />
                </div>
                <div>
                  <Label htmlFor="policy-token_reference">Reference tokens</Label>
                  <Input
                    id="policy-token_reference"
                    aria-invalid={!!fieldErrors["policy-token_reference"]}
                    aria-describedby="policy-token_reference-error"
                    type="number"
                    min={1}
                    value={Number.isNaN(policy.token_reference) ? "" : policy.token_reference}
                    onChange={(e) =>
                      setPolicy({ ...policy, token_reference: e.target.valueAsNumber })
                    }
                    className="mt-2"
                  />
                  <FieldError
                    id="policy-token_reference-error"
                    errors={fieldErrors["policy-token_reference"]}
                  />
                </div>
                <div>
                  <Label htmlFor="policy-tool_reference">Reference task tool calls</Label>
                  <Input
                    id="policy-tool_reference"
                    aria-invalid={!!fieldErrors["policy-tool_reference"]}
                    aria-describedby="policy-tool_reference-error"
                    type="number"
                    min={1}
                    value={Number.isNaN(policy.tool_reference) ? "" : policy.tool_reference}
                    onChange={(e) =>
                      setPolicy({ ...policy, tool_reference: e.target.valueAsNumber })
                    }
                    className="mt-2"
                  />
                  <FieldError
                    id="policy-tool_reference-error"
                    errors={fieldErrors["policy-tool_reference"]}
                  />
                </div>
                <div>
                  <Label htmlFor="policy-duration_reference">Reference time · seconds</Label>
                  <Input
                    id="policy-duration_reference"
                    aria-invalid={!!fieldErrors["policy-duration_reference"]}
                    aria-describedby="policy-duration_reference-error"
                    type="number"
                    min={1}
                    value={Number.isNaN(policy.duration_reference) ? "" : policy.duration_reference}
                    onChange={(e) =>
                      setPolicy({ ...policy, duration_reference: e.target.valueAsNumber })
                    }
                    className="mt-2"
                  />
                  <FieldError
                    id="policy-duration_reference-error"
                    errors={fieldErrors["policy-duration_reference"]}
                  />
                </div>
              </div>
              <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
                A zero efficiency penalty scores quality only.
              </p>
            </details>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-6">
            <div>
              <h3 tabIndex={-1} className="text-sm font-medium outline-none">
                Review and run
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Cases, models and scoring settings cannot change after launch.
              </p>
            </div>
            <div>
              <Label htmlFor="name">Evaluation name</Label>
              <Input
                id="name"
                aria-invalid={!!fieldErrors["name"]}
                aria-describedby="name-error"
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <FieldError id="name-error" errors={fieldErrors["name"]} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="repetitions">Attempts per case and model</Label>
                <Input
                  id="repetitions"
                  aria-invalid={!!fieldErrors["repetitions"]}
                  aria-describedby="repetitions-error"
                  className="mt-2"
                  type="number"
                  min={1}
                  max={10}
                  value={Number.isNaN(repetitions) ? "" : repetitions}
                  onChange={(e) => setRepetitions(e.target.valueAsNumber)}
                />
                <FieldError id="repetitions-error" errors={fieldErrors["repetitions"]} />
              </div>
              <div>
                <Label htmlFor="timeout_seconds">Timeout per attempt · seconds</Label>
                <Input
                  id="timeout_seconds"
                  aria-invalid={!!fieldErrors["timeout_seconds"]}
                  aria-describedby="timeout_seconds-error"
                  className="mt-2"
                  type="number"
                  min={30}
                  max={3600}
                  value={Number.isNaN(timeout) ? "" : timeout}
                  onChange={(e) => setTimeout(e.target.valueAsNumber)}
                />
                <FieldError id="timeout_seconds-error" errors={fieldErrors["timeout_seconds"]} />
              </div>
            </div>
            <p className="text-sm">
              Cases: {cases.length} · Models: {candidates.length} · Executions:{" "}
              {cases.length * candidates.length * repetitions}
            </p>
            <div className="rounded-md border p-4">
              <div className="flex gap-3">
                <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <div className="space-y-2 text-sm">
                  <p className="font-medium">
                    Uses this agent’s existing environment and live tools
                  </p>
                  <p className="text-muted-foreground leading-relaxed">
                    Attempts share files and external services. Live tools can change them; the
                    environment is not reset.
                  </p>
                  <p className="text-muted-foreground">
                    Delegated agents keep their configured models. Their usage is included. Runs and
                    judging may incur charges.
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
        <div className="mt-8 flex items-center justify-between border-t pt-5">
          <Button
            variant="ghost"
            onClick={() => {
              if (step > 0) {
                setStep(step - 1)
                setValidated(false)
                setError("")
                return
              }
              if (!dirty || window.confirm("Discard unsaved evaluation changes?")) onCancel()
            }}
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
    </section>
  )
}

function CaseInputs({
  workflow,
  caseId,
  errors,
  value,
  onChange,
}: {
  workflow: Workflow
  caseId: string
  errors: Record<string, { message: string }[]>
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
  const unknownInputs = Object.keys(values ?? {}).some((name) => !(name in (workflow.inputs ?? {})))
  if (json || !values || !workflow.inputs || unknownInputs) {
    const inputErrors = Object.entries(errors)
      .filter(([key]) => key === `${caseId}-inputs` || key.startsWith(`${caseId}-inputs-`))
      .flatMap(([key, issues]) =>
        issues.map((issue) => ({
          message:
            key === `${caseId}-inputs`
              ? issue.message
              : `${key.slice(`${caseId}-inputs-`.length)}: ${issue.message}`,
        }))
      )
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${caseId}-inputs`}>Workflow inputs · JSON</Label>
          {!workflow.arbitrary_json && values && !unknownInputs && (
            <Button size="sm" variant="ghost" onClick={() => setJSON(false)}>
              Use fields
            </Button>
          )}
        </div>
        <Textarea
          id={`${caseId}-inputs`}
          aria-invalid={inputErrors.length > 0}
          aria-describedby={`${caseId}-inputs-error`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="mt-2 min-h-36 font-mono text-xs"
          spellCheck={false}
        />
        <FieldError id={`${caseId}-inputs-error`} errors={inputErrors} />
      </div>
    )
  }
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
        const fieldId = `${caseId}-inputs-${name}`
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={fieldId}>
              {name}
              {input.required ? " *" : ""}
            </Label>
            {input.description && (
              <p className="text-muted-foreground text-xs">{input.description}</p>
            )}
            {input.enum ? (
              <select
                id={fieldId}
                aria-invalid={!!errors[fieldId]}
                aria-describedby={`${fieldId}-error`}
                className="bg-background aria-invalid:border-destructive h-9 w-full rounded-md border px-3 text-sm"
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
                id={fieldId}
                aria-invalid={!!errors[fieldId]}
                aria-describedby={`${fieldId}-error`}
                className="bg-background aria-invalid:border-destructive h-9 w-full rounded-md border px-3 text-sm"
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
                id={fieldId}
                aria-invalid={!!errors[fieldId]}
                aria-describedby={`${fieldId}-error`}
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
            <FieldError id={`${fieldId}-error`} errors={errors[fieldId]} />
          </div>
        )
      })}
    </fieldset>
  )
}
