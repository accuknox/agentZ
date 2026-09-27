"use client"

import { useEffect, useRef, useState } from "react"
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  FileUp,
  Plus,
  Trash2,
  Play,
  Sparkles,
  CircleAlert,
} from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field"
import { Badge } from "@/components/ui/badge"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  createWorkflowEvaluation,
  suggestWorkflowEvaluationCases,
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
  const [name, setName] = useState(
    previous
      ? draftId
        ? previous.request.name
        : `${previous.request.name} copy`
      : `${workflow.title || workflow.workflow_name} comparison`
  )
  const [cases, setCases] = useState<CaseDraft[]>(
    () =>
      previous?.request.cases.map((c) => ({ ...c, inputs: JSON.stringify(c.inputs, null, 2) })) ??
      []
  )
  const [selectedModels, setCandidates] = useState<EvaluationCandidate[] | undefined>(
    previous?.request.candidates
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
  const [discardOpen, setDiscardOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [validated, setValidated] = useState(false)
  const [focusRequest, setFocusRequest] = useState(0)
  const [openCases, setOpenCases] = useState<string[]>([])
  const [openSections, setOpenSections] = useState<string[]>([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const form = useRef<HTMLElement>(null)
  useEffect(() => {
    const target = error
      ? form.current?.querySelector<HTMLElement>("[data-evaluation-error]")
      : (form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        form.current?.querySelector<HTMLElement>("h3"))
    target?.focus()
  }, [focusRequest, error])
  const snapshot = JSON.stringify({ name, cases, selectedModels, policy, repetitions, timeout })
  const [saved, setSaved] = useState(snapshot)
  const dirty = saved !== snapshot
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
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

  const candidates =
    selectedModels ?? models.data?.filter((model) => !model.variant).slice(0, 2) ?? []
  const gradingPolicy = {
    ...policy,
    judge: policy.rubric.trim() ? (policy.judge ?? candidates[0]) : undefined,
  }
  const generation = useRef<AbortController | null>(null)
  const [preparationMessage, setPreparationMessage] = useState("")
  const preparation = useMutation({
    mutationFn: async ({
      drafts,
      controller,
    }: {
      drafts: CaseDraft[]
      controller: AbortController
    }) => {
      const existing = drafts.flatMap((c) => {
        try {
          const parsed = zEvaluationCase.safeParse({ ...c, inputs: JSON.parse(c.inputs) })
          return parsed.success ? [parsed.data] : []
        } catch {
          return []
        }
      })
      const response = await getGatewayBaseURL()
        .then((baseUrl) =>
          suggestWorkflowEvaluationCases({
            baseUrl,
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: { agentName: workflow.agent_name, workflowName: workflow.workflow_name },
            body: { cases: existing },
            signal: controller.signal,
          })
        )
        .catch(() => {
          throw new Error("Could not reach the agent. Try preparation again.")
        })
      if (response.error) throw new Error(response.error.message)
      return response.data
    },
    onSuccess: (result, { controller }) => {
      if (controller.signal.aborted) return
      setCases((current) => [
        ...current,
        ...result.cases.map((c) => ({
          id: crypto.randomUUID(),
          name: c.name,
          inputs: JSON.stringify(c.inputs, null, 2),
          expected: "",
        })),
      ])
      setPolicy((current) =>
        current.rubric.trim() ? current : { ...current, rubric: result.rubric }
      )
      setPreparationMessage("")
    },
    onError: (error, { controller }) => {
      if (!controller.signal.aborted) setPreparationMessage(error.message)
    },
  })
  const { mutate: prepare } = preparation
  useEffect(() => {
    if (!previous) {
      const controller = new AbortController()
      generation.current = controller
      prepare({ drafts: [], controller })
    }
    return () => generation.current?.abort()
  }, [prepare, previous])

  function validate() {
    const errors: Record<string, { message: string }[]> = {}
    const parsedCases: EvaluationCase[] = []
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
    if (!cases.length) errors.cases = [{ message: "Generate or add a test case." }]
    if (cases.length > 1000) errors.cases = [{ message: "Use at most 1,000 test cases." }]
    const result = zWorkflowEvaluationRequest
      .pick({
        candidates: true,
        policy: true,
        name: true,
        repetitions: true,
        timeout_seconds: true,
      })
      .safeParse(
        { name, candidates, policy: gradingPolicy, repetitions, timeout_seconds: timeout },
        { error: validationError }
      )
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path.join("-")
        errors[key] = [...(errors[key] ?? []), issue]
      }
    }
    if (!candidates.length) errors.candidates = [{ message: "Select at least one model." }]
    if (policy.rubric.trim() && !gradingPolicy.judge)
      errors["policy-judge"] = [{ message: "Choose a judge model." }]
    if (!policy.rubric.trim() && cases.some((c) => !c.expected.trim()))
      errors["policy-rubric"] = [
        { message: "Add a rubric, or give every test case an expected output." },
      ]
    if (cases.length * candidates.length * repetitions > 1000)
      errors.repetitions = [{ message: "Use at most 1,000 executions." }]
    return { errors, cases: parsedCases }
  }
  const validation = validate()
  const fieldErrors = validated ? validation.errors : {}
  async function submit(draft: boolean) {
    setError("")
    setValidated(true)
    if (Object.keys(validation.errors).length) {
      setOpenSections(["cases", "criteria", "settings"])
      setOpenCases(
        cases
          .filter((c) => Object.keys(validation.errors).some((key) => key.startsWith(`${c.id}-`)))
          .map((c) => c.id)
      )
      setFocusRequest((request) => request + 1)
      return
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
          cases: validation.cases,
          candidates,
          repetitions,
          timeout_seconds: timeout,
          policy: gradingPolicy,
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
    <section ref={form} className="flex w-full max-w-3xl min-w-0 flex-col gap-6 p-4 sm:p-6">
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard evaluation?</DialogTitle>
            <DialogDescription>Your unsaved cases and settings will be lost.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onCancel}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to evaluations"
          onClick={() => {
            if (dirty) {
              setDiscardOpen(true)
              return
            }
            onCancel()
          }}
        >
          <ArrowLeft />
        </Button>
        <h2 className="text-base font-semibold">{draftId ? "Edit draft" : "New evaluation"}</h2>
      </div>
      <FieldGroup>
        <Field data-invalid={!!fieldErrors.candidates}>
          <FieldLabel htmlFor="candidates">Models</FieldLabel>
          <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                id="candidates"
                variant="outline"
                role="combobox"
                aria-expanded={modelPickerOpen}
                aria-invalid={!!fieldErrors.candidates}
                aria-describedby="candidates-error"
                className="justify-between"
                disabled={busy || models.isPending}
              >
                {models.isPending ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Loading models
                  </>
                ) : candidates.length ? (
                  `${candidates.length} models selected`
                ) : (
                  "Select models"
                )}
                <ChevronsUpDown data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
              <Command>
                <CommandInput placeholder="Find a model…" />
                <CommandList>
                  <CommandEmpty>No models found.</CommandEmpty>
                  <CommandGroup>
                    {models.data?.map((model) => {
                      const selected = candidates.some((candidate) => candidate.id === model.id)
                      return (
                        <CommandItem
                          key={model.id}
                          value={model.id}
                          keywords={[model.label]}
                          data-checked={selected}
                          disabled={!selected && candidates.length >= 10}
                          onSelect={() =>
                            setCandidates(
                              selected
                                ? candidates.filter((candidate) => candidate.id !== model.id)
                                : [...candidates, model]
                            )
                          }
                        >
                          {model.label}
                          <span className="text-muted-foreground truncate text-xs">
                            {model.provider_id}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {candidates.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {candidates.map((model, index) => (
                <Badge key={model.id} variant="secondary">
                  {model.label}
                  {index === 0 && " · Baseline"}
                </Badge>
              ))}
            </div>
          )}
          <FieldError id="candidates-error" errors={fieldErrors.candidates} />
          {models.error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>Could not load models.</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => models.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          )}
          {models.data?.length === 0 && (
            <FieldDescription>Configure a model with tool support for this agent.</FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <div className="flex flex-col gap-3" aria-live="polite">
        <Alert
          variant={
            preparation.error && !preparation.variables?.controller.signal.aborted
              ? "destructive"
              : "default"
          }
        >
          {preparation.isPending ? (
            <Spinner />
          ) : preparation.error ? (
            <CircleAlert />
          ) : cases.length ? (
            <Check />
          ) : (
            <Sparkles />
          )}
          <AlertTitle>
            {preparation.isPending
              ? "Researching workflow…"
              : preparation.error
                ? "Could not prepare test cases"
                : preparationMessage ||
                  (cases.length ? `${cases.length} test cases ready` : "No test cases yet")}
          </AlertTitle>
          {preparation.isPending && (
            <AlertDescription>Reading references and checking test coverage.</AlertDescription>
          )}
          {preparation.error && !preparation.variables?.controller.signal.aborted && (
            <AlertDescription>
              {preparationMessage} Your existing cases are unchanged.
            </AlertDescription>
          )}
          <AlertAction>
            {preparation.isPending ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  generation.current?.abort()
                  preparation.reset()
                  setPreparationMessage("Preparation cancelled")
                }}
              >
                Cancel
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || cases.length >= 1000}
                onClick={() => {
                  const controller = new AbortController()
                  generation.current = controller
                  setPreparationMessage("")
                  prepare({ drafts: cases, controller })
                }}
              >
                <Sparkles data-icon="inline-start" />
                {preparation.error ? "Retry" : cases.length ? "Generate more" : "Generate"}
              </Button>
            )}
          </AlertAction>
        </Alert>
      </div>
      <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
        <AccordionItem value="cases">
          <AccordionTrigger aria-invalid={!!fieldErrors.cases}>
            Test cases
            {fieldErrors.cases && (
              <Badge variant="destructive" className="ml-2">
                Needs attention
              </Badge>
            )}
          </AccordionTrigger>
          <AccordionContent className="flex flex-col gap-4">
            <FieldError errors={fieldErrors.cases} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || preparation.isPending}
                onClick={() => {
                  const caseId = crypto.randomUUID()
                  setOpenCases((current) => [...current, caseId])
                  setCases([
                    ...cases,
                    {
                      id: caseId,
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
                }}
              >
                <Plus data-icon="inline-start" />
                Add case
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || preparation.isPending}
                onClick={() => fileInput.current?.click()}
              >
                <FileUp data-icon="inline-start" />
                Import
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,text/csv,.json,.csv"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importCases(file)
                  event.target.value = ""
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || preparation.isPending}
                onClick={importRuns}
              >
                Use past runs
              </Button>
            </div>
            <Accordion type="multiple" value={openCases} onValueChange={setOpenCases}>
              {cases.map((c, index) => (
                <AccordionItem key={c.id} value={c.id}>
                  <AccordionTrigger>{c.name || `Case ${index + 1}`}</AccordionTrigger>
                  <AccordionContent>
                    <FieldGroup>
                      <Field data-invalid={!!fieldErrors[`${c.id}-name`]}>
                        <FieldLabel htmlFor={`${c.id}-name`}>Name</FieldLabel>
                        <Input
                          id={`${c.id}-name`}
                          aria-invalid={!!fieldErrors[`${c.id}-name`]}
                          aria-describedby={`${c.id}-name-error`}
                          value={c.name}
                          onChange={(event) =>
                            setCases(
                              cases.map((item) =>
                                item.id === c.id ? { ...item, name: event.target.value } : item
                              )
                            )
                          }
                        />
                        <FieldError
                          id={`${c.id}-name-error`}
                          errors={fieldErrors[`${c.id}-name`]}
                        />
                      </Field>
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
                      <Field data-invalid={!!fieldErrors[`${c.id}-expected`]}>
                        <FieldLabel htmlFor={`${c.id}-expected`}>
                          Expected output · Optional
                        </FieldLabel>
                        <Textarea
                          id={`${c.id}-expected`}
                          aria-invalid={!!fieldErrors[`${c.id}-expected`]}
                          aria-describedby={`${c.id}-expected-error`}
                          value={c.expected}
                          onChange={(event) =>
                            setCases(
                              cases.map((item) =>
                                item.id === c.id ? { ...item, expected: event.target.value } : item
                              )
                            )
                          }
                        />
                        <FieldDescription>
                          Leave blank to use the success criteria.
                        </FieldDescription>
                        <FieldError
                          id={`${c.id}-expected-error`}
                          errors={fieldErrors[`${c.id}-expected`]}
                        />
                      </Field>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="self-start"
                        disabled={busy}
                        onClick={() => setCases(cases.filter((item) => item.id !== c.id))}
                      >
                        <Trash2 data-icon="inline-start" />
                        Remove case
                      </Button>
                    </FieldGroup>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="criteria">
          <AccordionTrigger>Success criteria</AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              <Field data-invalid={!!fieldErrors["policy-rubric"]}>
                <FieldLabel htmlFor="policy-rubric">What makes a good result?</FieldLabel>
                <Textarea
                  id="policy-rubric"
                  aria-invalid={!!fieldErrors["policy-rubric"]}
                  aria-describedby="policy-rubric-error"
                  className="min-h-32"
                  value={policy.rubric}
                  onChange={(event) => setPolicy({ ...policy, rubric: event.target.value })}
                />
                <FieldError id="policy-rubric-error" errors={fieldErrors["policy-rubric"]} />
              </Field>
              <Field data-invalid={!!fieldErrors["policy-judge"]}>
                <FieldLabel htmlFor="policy-judge">Judge model</FieldLabel>
                <Select
                  value={gradingPolicy.judge?.id ?? ""}
                  onValueChange={(id) =>
                    setPolicy({ ...policy, judge: models.data?.find((model) => model.id === id) })
                  }
                >
                  <SelectTrigger
                    id="policy-judge"
                    aria-invalid={!!fieldErrors["policy-judge"]}
                    aria-describedby="policy-judge-error"
                  >
                    <SelectValue placeholder="Choose a judge" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {models.data?.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  The same judge scores every model against these criteria.
                </FieldDescription>
                <FieldError id="policy-judge-error" errors={fieldErrors["policy-judge"]} />
              </Field>
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="settings">
          <AccordionTrigger>Advanced settings</AccordionTrigger>
          <AccordionContent>
            <FieldGroup>
              <Field data-invalid={!!fieldErrors.name}>
                <FieldLabel htmlFor="name">Evaluation name</FieldLabel>
                <Input
                  id="name"
                  value={name}
                  aria-invalid={!!fieldErrors.name}
                  aria-describedby="name-error"
                  onChange={(event) => setName(event.target.value)}
                />
                <FieldError id="name-error" errors={fieldErrors.name} />
              </Field>
              <FieldGroup className="grid sm:grid-cols-2">
                <Field data-invalid={!!fieldErrors.repetitions}>
                  <FieldLabel htmlFor="repetitions">Attempts per case</FieldLabel>
                  <Input
                    id="repetitions"
                    type="number"
                    min={1}
                    max={10}
                    value={Number.isNaN(repetitions) ? "" : repetitions}
                    aria-invalid={!!fieldErrors.repetitions}
                    aria-describedby="repetitions-error"
                    onChange={(event) => setRepetitions(event.target.valueAsNumber)}
                  />
                  <FieldError id="repetitions-error" errors={fieldErrors.repetitions} />
                </Field>
                <Field data-invalid={!!fieldErrors.timeout_seconds}>
                  <FieldLabel htmlFor="timeout_seconds">Timeout · Seconds</FieldLabel>
                  <Input
                    id="timeout_seconds"
                    type="number"
                    min={30}
                    max={3600}
                    value={Number.isNaN(timeout) ? "" : timeout}
                    aria-invalid={!!fieldErrors.timeout_seconds}
                    aria-describedby="timeout_seconds-error"
                    onChange={(event) => setTimeout(event.target.valueAsNumber)}
                  />
                  <FieldError id="timeout_seconds-error" errors={fieldErrors.timeout_seconds} />
                </Field>
              </FieldGroup>
              <FieldSet>
                <FieldLegend variant="label">Scoring</FieldLegend>
                <FieldDescription>
                  Set resource references from a known good run. A zero efficiency penalty scores
                  quality only.
                </FieldDescription>
                <FieldGroup className="grid sm:grid-cols-2">
                  {(
                    [
                      {
                        key: "minimum_quality",
                        label: "Minimum quality",
                        min: 0,
                        max: 1,
                        step: 0.05,
                      },
                      {
                        key: "efficiency_weight",
                        label: "Maximum efficiency penalty",
                        min: 0,
                        max: 1,
                        step: 0.05,
                      },
                      { key: "token_reference", label: "Reference tokens", min: 1, step: 1 },
                      { key: "tool_reference", label: "Reference tool calls", min: 1, step: 1 },
                      {
                        key: "duration_reference",
                        label: "Reference time · Seconds",
                        min: 1,
                        step: 1,
                      },
                    ] satisfies {
                      key: keyof Pick<
                        EvaluationPolicy,
                        | "minimum_quality"
                        | "efficiency_weight"
                        | "token_reference"
                        | "tool_reference"
                        | "duration_reference"
                      >
                      label: string
                      min: number
                      max?: number
                      step: number
                    }[]
                  ).map(({ key, label, min, max, step }) => (
                    <Field key={key} data-invalid={!!fieldErrors[`policy-${key}`]}>
                      <FieldLabel htmlFor={`policy-${key}`}>{label}</FieldLabel>
                      <Input
                        id={`policy-${key}`}
                        type="number"
                        min={min}
                        max={max}
                        step={step}
                        value={Number.isNaN(policy[key]) ? "" : policy[key]}
                        aria-invalid={!!fieldErrors[`policy-${key}`]}
                        aria-describedby={`policy-${key}-error`}
                        onChange={(event) =>
                          setPolicy({ ...policy, [key]: event.target.valueAsNumber })
                        }
                      />
                      <FieldError
                        id={`policy-${key}-error`}
                        errors={fieldErrors[`policy-${key}`]}
                      />
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <Separator />
      <FieldGroup>
        <Field orientation="horizontal">
          <Checkbox
            id="live-tools"
            checked={liveTools}
            onCheckedChange={(checked) => setLiveTools(checked === true)}
          />
          <FieldContent>
            <FieldLabel htmlFor="live-tools">Allow live tool actions</FieldLabel>
            <FieldDescription>
              Runs can change shared files and services and incur model charges.
            </FieldDescription>
          </FieldContent>
        </Field>
      </FieldGroup>
      {error && (
        <Alert variant="destructive" data-evaluation-error tabIndex={-1}>
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm">
          {cases.length * candidates.length * (Number.isNaN(repetitions) ? 0 : repetitions)}{" "}
          executions
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy || preparation.isPending}
            onClick={() => submit(true)}
          >
            Save draft
          </Button>
          <Button
            disabled={busy || preparation.isPending || !liveTools}
            onClick={() => submit(false)}
          >
            {busy ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}Run
            evaluation
          </Button>
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
      <Field data-invalid={inputErrors.length > 0}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${caseId}-inputs`}>Workflow inputs · JSON</FieldLabel>
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
          className="min-h-36"
          spellCheck={false}
        />
        <FieldError id={`${caseId}-inputs-error`} errors={inputErrors} />
      </Field>
    )
  }
  const fields = values
  return (
    <FieldSet>
      <FieldLegend variant="label">Workflow inputs</FieldLegend>
      <FieldGroup>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setJSON(true)}>
            Edit JSON
          </Button>
        </div>
        {Object.entries(workflow.inputs).map(([name, input]) => {
          const current = fields[name]
          const fieldId = `${caseId}-inputs-${name}`
          return (
            <Field key={name} data-invalid={!!errors[fieldId]}>
              <FieldLabel htmlFor={fieldId} required={input.required}>
                {name}
              </FieldLabel>
              {input.description && <FieldDescription>{input.description}</FieldDescription>}
              {input.enum || input.type === "boolean" ? (
                <Select
                  value={JSON.stringify(current) ?? ""}
                  onValueChange={(selected) => {
                    const choices = input.enum ?? [true, false]
                    onChange(
                      JSON.stringify(
                        {
                          ...values,
                          [name]: choices.find((choice) => JSON.stringify(choice) === selected),
                        },
                        null,
                        2
                      )
                    )
                  }}
                >
                  <SelectTrigger
                    id={fieldId}
                    aria-invalid={!!errors[fieldId]}
                    aria-describedby={`${fieldId}-error`}
                  >
                    <SelectValue placeholder="Choose a value" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {!input.required && <SelectItem value="unset">Not set</SelectItem>}
                      {(input.enum ?? [true, false]).map((choice) => (
                        <SelectItem key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                          {choice.toString()}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
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
            </Field>
          )
        })}
      </FieldGroup>
    </FieldSet>
  )
}
