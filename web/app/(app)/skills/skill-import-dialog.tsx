"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Bot, Check, FileArchive, Lock, Pencil, Replace, TriangleAlert } from "lucide-react"
import { Controller, useForm, useWatch, type Control, type FieldErrors } from "react-hook-form"
import { toast } from "sonner"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  importImmutableSkills,
  importMutableSkills,
  previewImmutableSkillImport,
  previewMutableSkillImport,
  type Agent,
  type AgentName,
  type ImmutableSkillImportPreviewItem,
  type MutableSkillImportPreviewItem,
  type SkillImportDecision,
} from "@/lib/gateway/client"
import { zAgentName, zSkillName } from "@/lib/gateway/client/zod.gen"
import { cn } from "@/lib/utils"

const importTypeSchema = z.enum(["mutable", "immutable"])
const renameSchema = z.string().refine((name) => zSkillName.safeParse(name).success, {
  message: "Use 1–32 lowercase letters, numbers, or hyphens",
})
const importFormSchema = z
  .object({
    type: importTypeSchema,
    agents: z
      .array(zAgentName)
      .max(200, "Select at most 200 agents")
      .refine((names) => new Set(names).size === names.length, "Agents must be unique"),
    resolutions: z.record(z.string(), z.enum(["create", "overwrite", "rename"])),
    renames: z.record(z.string(), z.string()),
  })
  .superRefine((value, ctx) => {
    if (value.type === "mutable" && value.agents.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Select at least one agent",
        path: ["agents"],
      })
    }
    for (const [name, resolution] of Object.entries(value.resolutions)) {
      if (resolution !== "rename") continue
      const rename = renameSchema.safeParse(value.renames[name])
      if (rename.success) continue
      ctx.addIssue({
        code: "custom",
        message: rename.error.issues[0]?.message ?? "Skill name is invalid",
        path: ["renames", name],
      })
    }
  })

type ImportFormValues = z.infer<typeof importFormSchema>
type ImportResolution = ImportFormValues["resolutions"][string]
type ImportPreview = {
  name: ImmutableSkillImportPreviewItem["name"]
  immutableConflict: boolean
  mutableConflictAgents: MutableSkillImportPreviewItem["conflict_agents"]
}

export function SkillImportDialog({
  agents,
  canImportImmutable,
  open,
  setOpen,
  onImported,
  workspaceId,
}: {
  agents: Agent[]
  canImportImmutable: boolean
  open: boolean
  setOpen: (open: boolean) => void
  onImported: () => Promise<void>
  workspaceId?: string
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [inputKey, setInputKey] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const [file, setFile] = React.useState<File>()
  const [preview, setPreview] = React.useState<ImportPreview[]>([])
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const defaultType = workspaceId && agents.length > 0 ? "mutable" : "immutable"
  const emptyForm = {
    type: defaultType,
    agents: [],
    resolutions: {},
    renames: {},
  } satisfies ImportFormValues
  const form = useForm<ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    defaultValues: emptyForm,
    mode: "onSubmit",
    reValidateMode: "onChange",
  })
  const type = useWatch({ control: form.control, name: "type" })
  const selectedAgents = useWatch({ control: form.control, name: "agents" })
  const resolutions = useWatch({ control: form.control, name: "resolutions" })
  const conflicts = preview.filter((skill) => skillHasConflict(skill, type, selectedAgents)).length
  const scopeHeaders = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined

  function reset() {
    setDragging(false)
    setFile(undefined)
    setPreview([])
    setError(undefined)
    setInputKey((current) => current + 1)
    form.reset(emptyForm)
  }

  function chooseFile(nextFile: File | undefined) {
    if (nextFile && !/\.(md|zip)$/i.test(nextFile.name)) {
      setFile(undefined)
      setPreview([])
      setError("Import file must be .md or .zip")
      return
    }
    setFile(nextFile)
    setPreview([])
    setError(undefined)
    form.reset(emptyForm)
  }

  function chooseDroppedFile(items: DataTransferItemList, files: FileList) {
    if (items.length > 0) {
      const dropped = Array.from(items, (item) => item.getAsFile())
      if (dropped.some((item) => item === null)) {
        chooseFile(undefined)
        setError("Drop a .md or .zip file, not a folder")
        return
      }
      chooseFile(dropped[0] ?? undefined)
      return
    }
    chooseFile(files[0])
  }

  function previewImport() {
    if (!file) {
      return
    }
    startTransition(async () => {
      setError(undefined)
      const readyAgents = agents
        .filter((agent) => agent.status === "IDLE")
        .map((agent) => agent.name)
      const [mutableResult, immutableResult] = await Promise.all([
        workspaceId && readyAgents.length > 0
          ? previewMutableSkillImport({
              body: { agents: readyAgents, file },
              headers: scopeHeaders,
            })
          : undefined,
        canImportImmutable
          ? previewImmutableSkillImport({ body: { file }, headers: scopeHeaders })
          : undefined,
      ])
      if (mutableResult?.error) {
        setError(mutableResult.error.message)
        return
      }
      if (immutableResult?.error) {
        setError(immutableResult.error.message)
        return
      }
      const mutableSkills = new Map(
        mutableResult?.data.skills.map((skill) => [skill.name, skill.conflict_agents]) ?? []
      )
      const immutableSkills = new Map(
        immutableResult?.data.skills.map((skill) => [skill.name, skill.conflict]) ?? []
      )
      const names = new Set([...mutableSkills.keys(), ...immutableSkills.keys()])
      const nextPreview = [...names].map((name) => ({
        name,
        immutableConflict: immutableSkills.get(name) ?? false,
        mutableConflictAgents: mutableSkills.get(name) ?? [],
      }))
      if (nextPreview.length === 0) {
        setError("No importable skills found")
        return
      }
      setPreview(nextPreview)
      form.reset({
        type: workspaceId && readyAgents.length > 0 ? "mutable" : "immutable",
        agents: [],
        resolutions: Object.fromEntries(nextPreview.map((skill) => [skill.name, "create"])),
        renames: Object.fromEntries(nextPreview.map((skill) => [skill.name, ""])),
      })
    })
  }

  function applyImport(values: ImportFormValues) {
    if (!file || preview.length === 0) {
      return
    }
    const decisions: SkillImportDecision[] = preview.map((skill) => {
      const conflict = skillHasConflict(skill, values.type, values.agents)
      const resolution = values.resolutions[skill.name]
      if (conflict && resolution === "rename") {
        return {
          action: "rename",
          name: skill.name,
          rename: renameSchema.parse(values.renames[skill.name]),
        }
      }
      return { action: conflict ? "overwrite" : "create", name: skill.name }
    })

    startTransition(async () => {
      setError(undefined)
      const result =
        values.type === "mutable"
          ? await importMutableSkills({
              body: {
                agents: values.agents,
                decisions: JSON.stringify(decisions),
                file,
              },
              headers: scopeHeaders,
            })
          : await importImmutableSkills({
              body: {
                agents: workspaceId ? values.agents : undefined,
                decisions: JSON.stringify(decisions),
                file,
              },
              headers: scopeHeaders,
            })
      if (result.error) {
        setError(result.error.message)
        toast.error(preview.length === 1 ? "Failed to import skill" : "Failed to import skills")
        return
      }
      const failed = result.data.agents.filter((agent) => agent.status === "failed")
      if (failed.length > 0) {
        const names = failed.map((agent) => agent.agent)
        toast.warning(
          failed.length <= 3
            ? `Import failed for ${names.join(", ")}`
            : `Import failed for ${failed.length} agents`
        )
      } else {
        toast.success(preview.length === 1 ? "Skill imported" : "Skills imported")
      }
      reset()
      setOpen(false)
      await onImported()
    })
  }

  function reportInvalidSubmit(errors: FieldErrors<ImportFormValues>) {
    const message =
      errors.agents?.message ?? errors.type?.message ?? "Resolve import errors before continuing"
    setError(message)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          reset()
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import skills</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit(applyImport, reportInvalidSubmit)}
        >
          <button
            type="button"
            aria-label="Skill file"
            className={cn(
              "flex min-h-36 w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dotted p-6 text-center transition-colors outline-none",
              "border-border/70 text-muted-foreground hover:bg-muted/30 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3",
              dragging && "border-primary bg-primary/10 text-primary",
              error && !dragging && "border-destructive/60 bg-destructive/5 text-destructive"
            )}
            disabled={pending}
            onClick={() => inputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              chooseDroppedFile(event.dataTransfer.items, event.dataTransfer.files)
            }}
          >
            <FileArchive aria-hidden="true" className="size-7" />
            <span className="text-sm">{file ? file.name : "Drop or choose a .md/.zip file"}</span>
          </button>
          <Input
            key={inputKey}
            ref={inputRef}
            className="hidden"
            type="file"
            accept=".md,.zip"
            disabled={pending}
            onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
          />
          {preview.length === 0 ? (
            <>
              {error ? (
                <p className="text-destructive flex items-center gap-2 text-sm">
                  <TriangleAlert className="size-4" />
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" disabled={!file || pending} onClick={previewImport}>
                  {pending ? <Spinner /> : <FileArchive />}
                  Preview
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Controller
                  name="type"
                  control={form.control}
                  render={({ field }) => (
                    <Field>
                      <FieldLabel>Type</FieldLabel>
                      <Select
                        value={field.value}
                        disabled={pending}
                        onValueChange={(value) => {
                          const nextType = importTypeSchema.parse(value)
                          field.onChange(nextType)
                          form.setValue("agents", [], {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                          form.setValue(
                            "resolutions",
                            Object.fromEntries(preview.map((skill) => [skill.name, "create"]))
                          )
                          form.setValue("renames", {})
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {workspaceId && agents.length > 0 ? (
                              <SelectItem value="mutable">
                                <Pencil /> Mutable
                              </SelectItem>
                            ) : null}
                            {canImportImmutable ? (
                              <SelectItem value="immutable">
                                <Lock /> Immutable
                              </SelectItem>
                            ) : null}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                />
                {workspaceId ? (
                  <Controller
                    name="agents"
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid}>
                        <FieldLabel>Agents</FieldLabel>
                        <MultiSelectDropdown
                          invalid={fieldState.invalid}
                          disabled={pending}
                          options={agents.map((agent) => ({
                            disabled: agent.status !== "IDLE",
                            icon: Bot,
                            label: agent.name,
                            value: agent.name,
                          }))}
                          value={field.value}
                          placeholder="Select agents"
                          onBlurAction={field.onBlur}
                          onValueChangeAction={(values) => {
                            field.onChange(values)
                            form.setValue(
                              "resolutions",
                              Object.fromEntries(preview.map((skill) => [skill.name, "create"]))
                            )
                            form.setValue("renames", {})
                          }}
                        />
                        {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                      </Field>
                    )}
                  />
                ) : null}
              </div>
              <div className="rounded-md border">
                {preview.map((skill) => (
                  <ImportPreviewRow
                    key={skill.name}
                    agents={selectedAgents}
                    control={form.control}
                    pending={pending}
                    resolution={resolutions[skill.name] ?? "create"}
                    skill={skill}
                    type={type}
                    onResolutionChange={(name, resolution) =>
                      form.setValue(`resolutions.${name}`, resolution, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                  />
                ))}
              </div>
              <div className="text-muted-foreground flex items-center justify-between text-sm">
                <span>{preview.length} ready</span>
                <span>
                  {conflicts} conflict{conflicts === 1 ? "" : "s"}
                </span>
              </div>
              {error ? (
                <p className="text-destructive flex items-center gap-2 text-sm">
                  <TriangleAlert className="size-4" />
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => void form.handleSubmit(applyImport, reportInvalidSubmit)()}
                >
                  {pending ? <Spinner /> : <Check />}
                  Import
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ImportPreviewRow({
  agents,
  control,
  pending,
  resolution,
  skill,
  type,
  onResolutionChange,
}: {
  agents: AgentName[]
  control: Control<ImportFormValues>
  pending: boolean
  resolution: ImportResolution
  skill: ImportPreview
  type: ImportFormValues["type"]
  onResolutionChange: (name: string, resolution: ImportResolution) => void
}) {
  const conflict = skillHasConflict(skill, type, agents)
  return (
    <div className="border-b p-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {conflict ? (
            <TriangleAlert className="text-warning size-4 shrink-0" />
          ) : (
            <Check className="text-primary size-4 shrink-0" />
          )}
          <span className="truncate font-medium" title={skill.name}>
            {skill.name}
          </span>
        </div>
        <span className={cn("text-sm", conflict ? "text-warning" : "text-primary")}>
          {conflict ? "Conflict" : "Create"}
        </span>
      </div>
      {conflict ? (
        <div className="mt-2 grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3">
          <Select
            value={resolution === "rename" ? "rename" : "overwrite"}
            disabled={pending}
            onValueChange={(value) =>
              onResolutionChange(skill.name, value === "rename" ? "rename" : "overwrite")
            }
          >
            <SelectTrigger aria-label={`Resolution for ${skill.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="overwrite">
                  <Replace /> Overwrite
                </SelectItem>
                <SelectItem value="rename">
                  <Pencil /> Rename
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {resolution === "rename" ? (
            <Controller
              name={`renames.${skill.name}`}
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="gap-1">
                  <Input
                    {...field}
                    aria-label={`New name for ${skill.name}`}
                    autoComplete="off"
                    disabled={pending}
                    aria-invalid={fieldState.invalid}
                    placeholder="new-skill-name"
                    onChange={field.onChange}
                  />
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
          ) : (
            <div className="text-muted-foreground flex items-center justify-end gap-2 text-sm">
              <Replace className="size-4" />
              <span>Will overwrite</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function skillHasConflict(
  skill: ImportPreview,
  type: ImportFormValues["type"],
  agents: AgentName[]
): boolean {
  if (type === "immutable") {
    return skill.immutableConflict
  }
  const selected = new Set(agents)
  return skill.mutableConflictAgents.some((agent) => selected.has(agent))
}
