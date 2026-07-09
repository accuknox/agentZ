"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Check, FileArchive, RotateCcw, TriangleAlert } from "lucide-react"
import { Controller, useForm, type Control } from "react-hook-form"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

const importPreviewSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      conflict: z.boolean(),
    })
  ),
})

const apiErrorSchema = z.object({
  error: z.string(),
})

const skillNameSchema = z
  .string({ error: "Skill name is required" })
  .trim()
  .min(1, "Skill name is required")
  .max(64, "Skill name must be at most 64 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name is invalid")

const importFormSchema = z.object({
  renames: z.record(z.string(), skillNameSchema),
})

type ImportPreview = z.infer<typeof importPreviewSchema>["skills"][number]
type ImportFormValues = z.infer<typeof importFormSchema>
type ImportChoice = {
  action: "create" | "overwrite" | "rename"
  rename: string
}

type ImportPreviewRowProps = {
  action: ImportChoice["action"]
  control: Control<ImportFormValues>
  pending: boolean
  rename: string
  skill: ImportPreview
  onActionChange: (name: string, action: ImportChoice["action"]) => void
  onRenameChange: (name: string, rename: string) => void
}

const ImportPreviewRow = React.memo(function ImportPreviewRow({
  action,
  control,
  pending,
  rename,
  skill,
  onActionChange,
  onRenameChange,
}: ImportPreviewRowProps) {
  return (
    <div className="min-w-0 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {skill.conflict ? (
            <TriangleAlert aria-hidden="true" className="text-destructive size-4 shrink-0" />
          ) : (
            <Check aria-hidden="true" className="text-primary size-4 shrink-0" />
          )}
          <span className="min-w-0 truncate font-medium" title={skill.name}>
            {skill.name}
          </span>
        </div>
        <span
          className={cn("shrink-0 text-sm", skill.conflict ? "text-destructive" : "text-primary")}
        >
          {skill.conflict ? "Conflict" : "Create"}
        </span>
      </div>
      {skill.conflict ? (
        <div className="mt-2 grid min-w-0 grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3">
          <Select
            value={action}
            onValueChange={(value) => {
              onActionChange(skill.name, value === "rename" ? "rename" : "overwrite")
            }}
          >
            <SelectTrigger className="w-full" aria-label={`Resolution for ${skill.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="overwrite">Overwrite</SelectItem>
                <SelectItem value="rename">Rename</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {action === "rename" ? (
            <Controller
              name={`renames.${skill.name}`}
              control={control}
              defaultValue={rename}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="min-w-0 gap-1">
                  <Input
                    {...field}
                    className="min-w-0"
                    aria-label={`New name for ${skill.name}`}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={fieldState.invalid}
                    disabled={pending}
                    placeholder="new-skill-name..."
                    onChange={(event) => {
                      field.onChange(event)
                      onRenameChange(skill.name, event.currentTarget.value)
                    }}
                  />
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
          ) : (
            <div className="text-muted-foreground flex min-w-0 items-center justify-end gap-2 text-sm">
              <RotateCcw aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">Will replace existing skill</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
})

export function SkillImportDialog({
  agentName,
  open,
  setOpen,
  onImported,
}: {
  agentName: string
  open: boolean
  setOpen: (open: boolean) => void
  onImported: () => Promise<void>
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const [file, setFile] = React.useState<File>()
  const [preview, setPreview] = React.useState<ImportPreview[]>([])
  const [choices, setChoices] = React.useState<Record<string, ImportChoice>>({})
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const {
    clearErrors,
    control,
    handleSubmit,
    reset: resetForm,
  } = useForm<ImportFormValues>({
    resolver: zodResolver(importFormSchema),
    defaultValues: {
      renames: {},
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
    shouldUnregister: true,
  })
  const conflicts = preview.filter((skill) => skill.conflict).length

  const changeAction = React.useCallback((name: string, action: ImportChoice["action"]) => {
    setChoices((current) => ({
      ...current,
      [name]: {
        action,
        rename: current[name]?.rename ?? "",
      },
    }))
  }, [])

  const changeRename = React.useCallback((name: string, rename: string) => {
    setChoices((current) => ({
      ...current,
      [name]: {
        action: "rename",
        rename,
      },
    }))
  }, [])

  function reset() {
    setDragging(false)
    setFile(undefined)
    setPreview([])
    setChoices({})
    setError(undefined)
    resetForm({ renames: {} })
    if (inputRef.current) {
      inputRef.current.value = ""
    }
  }

  function chooseFile(nextFile: File | undefined) {
    if (nextFile && !/\.(md|zip)$/i.test(nextFile.name)) {
      setFile(undefined)
      setPreview([])
      setChoices({})
      setError("Import file must be .md or .zip. Choose a supported file.")
      return
    }
    setFile(nextFile)
    setPreview([])
    setChoices({})
    setError(undefined)
    resetForm({ renames: {} })
  }

  function chooseDroppedFile(items: DataTransferItemList, files: FileList) {
    if (items.length > 0) {
      const droppedFiles = Array.from(items, (item) => item.getAsFile())
      if (droppedFiles.some((item) => item === null)) {
        chooseFile(undefined)
        setError("Drop a .md or .zip file, not a folder")
        return
      }
      const firstFile = droppedFiles[0]
      if (!firstFile) {
        chooseFile(undefined)
        return
      }
      chooseFile(firstFile)
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
      try {
        const form = new FormData()
        form.set("agentName", agentName)
        form.set("file", file)
        const response = await fetch("/api/skills/import/preview", {
          method: "POST",
          body: form,
        })
        const data = await response.json()
        if (!response.ok) {
          setError(apiErrorSchema.parse(data).error)
          return
        }

        const nextPreview = importPreviewSchema.parse(data).skills
        setPreview(nextPreview)
        setChoices(
          Object.fromEntries(
            nextPreview.map((skill) => [
              skill.name,
              {
                action: skill.conflict ? "overwrite" : "create",
                rename: "",
              } satisfies ImportChoice,
            ])
          )
        )
        resetForm({
          renames: Object.fromEntries(nextPreview.map((skill) => [skill.name, ""])),
        })
      } catch {
        setError("Preview failed. Try again or pick a different file.")
      }
    })
  }

  function applyImport(values: ImportFormValues) {
    if (!file || preview.length === 0) {
      return
    }

    const decisions = preview.map((skill) => {
      const choice = choices[skill.name]
      if (!choice) {
        return {
          action: "create",
          name: skill.name,
        }
      }
      if (choice.action === "rename") {
        return {
          action: "rename",
          name: skill.name,
          rename: values.renames[skill.name] ?? choice.rename,
        }
      }
      return {
        action: choice.action,
        name: skill.name,
      }
    })

    startTransition(async () => {
      setError(undefined)
      try {
        const form = new FormData()
        form.set("agentName", agentName)
        form.set("file", file)
        form.set("decisions", JSON.stringify(decisions))
        const response = await fetch("/api/skills/import/apply", {
          method: "POST",
          body: form,
        })
        const data = await response.json()
        if (!response.ok) {
          setError(apiErrorSchema.parse(data).error)
          return
        }
        reset()
        setOpen(false)
        await onImported()
      } catch {
        setError("Import failed. Try again.")
      }
    })
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload skill</DialogTitle>
          <DialogDescription>Upload a Markdown or zip skill file.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            aria-label="Skill file"
            className={cn(
              "flex min-h-40 touch-manipulation flex-col items-center justify-center gap-3 rounded-lg border-2 border-dotted p-6 text-center transition-colors outline-none",
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
            <span className="text-sm">
              {file ? file.name : "Drag and drop or click to upload…"}
            </span>
            {!file ? <span className="text-muted-foreground text-xs">.md or .zip</span> : null}
          </button>
          <Input
            ref={inputRef}
            className="hidden"
            type="file"
            name="skill-file"
            aria-label="Skill file"
            accept=".md,.zip"
            disabled={pending}
            onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
          />
          {error ? (
            <p aria-live="polite" className="text-destructive flex items-center gap-2 text-sm">
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
              {error}
            </p>
          ) : null}
          {preview.length > 0 ? (
            <div
              className="text-muted-foreground flex items-center justify-between gap-3 text-sm tabular-nums"
              aria-live="polite"
            >
              <span>
                {preview.length} skill{preview.length === 1 ? "" : "s"} ready
              </span>
              {conflicts > 0 ? (
                <span className="text-destructive">
                  {conflicts} conflict{conflicts === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-primary">No conflicts</span>
              )}
            </div>
          ) : null}
          {preview.length > 0 ? (
            <div>
              {preview.map((skill) => {
                const choice = choices[skill.name]
                return (
                  <ImportPreviewRow
                    key={skill.name}
                    action={choice?.action ?? "overwrite"}
                    control={control}
                    pending={pending}
                    rename={choice?.rename ?? ""}
                    skill={skill}
                    onActionChange={changeAction}
                    onRenameChange={changeRename}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          {preview.length === 0 ? (
            <Button type="button" disabled={!file || pending} onClick={previewImport}>
              {pending ? <Spinner /> : null}
              Preview
            </Button>
          ) : (
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                clearErrors()
                void handleSubmit(applyImport)()
              }}
            >
              {pending ? <Spinner /> : null}
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
