"use client"

import * as React from "react"
import { Check, FileArchive, RotateCcw, TriangleAlert } from "lucide-react"
import * as z from "zod"
import { Button } from "@/components/ui/button"
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

type ImportPreview = z.infer<typeof importPreviewSchema>["skills"][number]
type ImportChoice = {
  action: "create" | "overwrite" | "rename"
  rename: string
}

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
  const conflicts = preview.filter((skill) => skill.conflict).length

  function reset() {
    setDragging(false)
    setFile(undefined)
    setPreview([])
    setChoices({})
    setError(undefined)
    if (inputRef.current) {
      inputRef.current.value = ""
    }
  }

  function chooseFile(nextFile: File | undefined) {
    if (nextFile && !/\.(md|zip)$/i.test(nextFile.name)) {
      setFile(undefined)
      setPreview([])
      setChoices({})
      setError("Import file must be .md or .zip")
      return
    }
    setFile(nextFile)
    setPreview([])
    setChoices({})
    setError(undefined)
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
      } catch {
        setError("Preview failed")
      }
    })
  }

  function applyImport() {
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
          rename: choice.rename,
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
        setError("Import failed")
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
          <DialogDescription className="sr-only">
            Upload a Markdown or zip skill file.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className={cn(
              "border-border/70 text-muted-foreground hover:bg-muted/30 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dotted p-6 text-center transition-colors",
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
            <FileArchive />
            <span className="text-sm">{file ? file.name : "Drag and drop or click to upload"}</span>
          </button>
          <Input
            ref={inputRef}
            className="hidden"
            type="file"
            accept=".md,.zip"
            disabled={pending}
            onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
          />
          {error ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {error}
            </p>
          ) : null}
          {preview.length > 0 ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {preview.length} skill{preview.length === 1 ? "" : "s"} ready
              </span>
              {conflicts > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">
                  {conflicts} conflict{conflicts === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-emerald-600 dark:text-emerald-400">No conflicts</span>
              )}
            </div>
          ) : null}
          {preview.length > 0 ? (
            <div className="max-h-72 overflow-y-auto">
              {preview.map((skill) => {
                const choice = choices[skill.name]
                return (
                  <div key={skill.name} className="min-w-0 border-b py-3 last:border-b-0">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        {skill.conflict ? (
                          <TriangleAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        ) : (
                          <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        )}
                        <span className="min-w-0 truncate font-medium" title={skill.name}>
                          {skill.name}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 text-sm",
                          skill.conflict
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        )}
                      >
                        {skill.conflict ? "Conflict" : "Create"}
                      </span>
                    </div>
                    {skill.conflict ? (
                      <div className="mt-2 grid min-w-0 grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3">
                        <Select
                          value={choice?.action ?? "overwrite"}
                          onValueChange={(value) => {
                            setChoices((current) => ({
                              ...current,
                              [skill.name]: {
                                action: value === "rename" ? "rename" : "overwrite",
                                rename: current[skill.name]?.rename ?? "",
                              },
                            }))
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="overwrite">Overwrite</SelectItem>
                              <SelectItem value="rename">Rename</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {choice?.action === "rename" ? (
                          <Input
                            value={choice.rename}
                            className="min-w-0"
                            disabled={pending}
                            placeholder="new-skill-name"
                            onChange={(event) => {
                              const rename = event.currentTarget.value
                              setChoices((current) => ({
                                ...current,
                                [skill.name]: {
                                  action: "rename",
                                  rename,
                                },
                              }))
                            }}
                          />
                        ) : (
                          <div className="text-muted-foreground flex min-w-0 items-center justify-end gap-2 text-sm">
                            <RotateCcw className="size-4 shrink-0" />
                            <span className="truncate">Will replace existing skill</span>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
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
            <Button type="button" disabled={pending} onClick={applyImport}>
              {pending ? <Spinner /> : null}
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
