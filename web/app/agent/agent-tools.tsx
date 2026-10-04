"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table"
import {
  Braces,
  CircleAlert,
  Hash,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ToggleLeft,
  Trash2,
  Type,
  type LucideIcon,
  Upload,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { deleteAgentToolAction, saveAgentToolAction } from "@/data/agent.actions"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
  listAgentTools,
  type AgentTool,
  type AgentTools as ToolConfiguration,
  type ToolInputType,
} from "@/lib/gateway/client"
import { zAgentTool } from "@/lib/gateway/client/zod.gen"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  description: { minWidth: 256, contentMaxWidth: 320, hiddenBelow: "md" },
  filename: { minWidth: 160, contentMaxWidth: 192 },
  inputs: { minWidth: 80, width: 80, align: "end", hiddenBelow: "sm" },
  actions: { minWidth: 64, width: 64, align: "end" },
}

const inputTypes = [
  { value: "string", label: "Text", icon: Type },
  { value: "number", label: "Number", icon: Hash },
  { value: "integer", label: "Integer", icon: ListOrdered },
  { value: "boolean", label: "Boolean", icon: ToggleLeft },
  { value: "json", label: "JSON", icon: Braces },
] satisfies { value: ToolInputType; label: string; icon: LucideIcon }[]

const examples = {
  bash: `city=$(jq -r '.city | @uri')
curl --fail --silent --show-error --max-time 20 "https://wttr.in/$city?format=3"`,
  python: `import json, sys
from urllib.parse import quote
from urllib.request import urlopen

args = json.load(sys.stdin)
city = quote(args["city"], safe="")
with urlopen(f"https://wttr.in/{city}?format=3", timeout=20) as response:
    print(response.read().decode())`,
  node: `// requires Node.js 24.14+
import { readFileSync } from "node:fs"
import { setGlobalProxyFromEnv } from "node:http"

const { city } = JSON.parse(readFileSync(0, "utf8"))
// fetch ignores HTTPS_PROXY and NO_PROXY unless proxy support is enabled.
setGlobalProxyFromEnv()

const response = await fetch(\`https://wttr.in/\${encodeURIComponent(city)}?format=3\`, {
  signal: AbortSignal.timeout(20_000),
})
if (!response.ok) throw new Error(\`Weather request failed: \${response.status}\`)
console.log(await response.text())`,
}

/** AgentTools keeps uploaded definitions and rollout status scoped to one agent. */
export function AgentTools({
  agentName,
  workspaceId,
  initial,
}: {
  agentName: string
  workspaceId: string
  initial: ToolConfiguration
}) {
  "use no memo"

  const client = useQueryClient()
  const queryKey = ["agentTools", workspaceId, agentName] as const
  const options = queryOptions({
    queryKey,
    initialData: initial,
    queryFn: async ({ signal }) => {
      const result = await listAgentTools({
        baseUrl: await getGatewayBaseURL(),
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName },
        signal,
      })
      if (result.error) throw new Error(result.error.message)
      return result.data
    },
    refetchInterval: (query) => (query.state.data?.applied ? false : 2000),
    retry: false,
  })
  const query = useQuery(options)
  const config = query.data
  const failed = query.isError || config.status === "DEGRADED"
  const [upload, setUpload] = useState<{ tool?: AgentTool; version: string }>()
  const [deleting, setDeleting] = useState<{ tool: AgentTool; version: string }>()
  const [deleteError, setDeleteError] = useState<string>()
  const [pending, startTransition] = useTransition()

  // Stable cells keep an open action menu mounted during status polling.
  const columns = useMemo<ColumnDef<AgentTool>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Tool",
        cell: ({ row }) => (
          <span className="block truncate font-mono font-medium" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="text-muted-foreground block truncate" title={row.original.description}>
            {row.original.description}
          </span>
        ),
      },
      {
        accessorKey: "filename",
        header: "Script",
        cell: ({ row }) => (
          <span className="block truncate font-mono text-xs" title={row.original.filename}>
            {row.original.filename}
          </span>
        ),
      },
      {
        id: "inputs",
        header: "Inputs",
        cell: ({ row }) => row.original.inputs.length,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Open menu for ${row.original.name}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onSelect={() =>
                      setUpload({ tool: row.original, version: config.resource_version })
                    }
                  >
                    <Pencil aria-hidden="true" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      setDeleting({ tool: row.original, version: config.resource_version })
                      setDeleteError(undefined)
                    }}
                  >
                    <Trash2 aria-hidden="true" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [config.resource_version]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: config.tools,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (tool) => tool.name,
    enableSorting: false,
  })

  async function saved(next: ToolConfiguration) {
    await client.cancelQueries({ queryKey })
    client.setQueryData(queryKey, next)
    setUpload(undefined)
  }

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium">Custom tools</h2>
          <p className="text-muted-foreground text-sm">
            Convert your existing bash/python/node scripts into tools your agent can invoke.
          </p>
        </div>
        <Button
          disabled={config.tools.length >= 32}
          onClick={() => setUpload({ version: config.resource_version })}
        >
          <Wrench aria-hidden="true" /> Create tool
        </Button>
      </div>

      {!config.applied || query.error ? (
        <Alert
          className={cn(
            "mx-4 w-auto gap-x-3 rounded-lg border-2 border-dashed p-4 md:mx-6",
            failed
              ? "border-destructive/60 bg-destructive/5"
              : "border-primary/60 bg-primary/5 text-primary"
          )}
          variant={failed ? "destructive" : "default"}
        >
          {failed ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
          )}
          <AlertTitle>
            {query.error
              ? "Tools could not be refreshed"
              : config.status === "DEGRADED"
                ? "Tools could not be applied"
                : "Applying tools"}
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {query.error?.message ?? config.message}
          </AlertDescription>
        </Alert>
      ) : null}

      <AdminDataGrid
        ariaLabel="Custom tools"
        rows={config.tools}
        table={table}
        layout={layout}
        onRowActivate={(tool) => setUpload({ tool, version: config.resource_version })}
        rowAriaLabel={(tool) => `Edit tool ${tool.name}`}
        emptyState={
          <Empty className="mx-4 min-h-64 w-auto border-2 md:mx-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wrench aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No custom tools yet</EmptyTitle>
              <EmptyDescription>
                Upload a Bash, Python, or Node.js script. Define its inputs and the agent will know
                how to call it.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setUpload({ version: config.resource_version })}>
              <Wrench aria-hidden="true" /> Create tool
            </Button>
          </Empty>
        }
      />
      {upload ? (
        <ToolUpload
          key={upload.version}
          agentName={agentName}
          workspaceId={workspaceId}
          existing={upload.tool}
          version={upload.version}
          onClose={() => setUpload(undefined)}
          onSaved={saved}
          onReload={async () => {
            const result = await query.refetch()
            if (!result.isSuccess) throw result.error ?? new Error("Tools could not be refreshed.")
            const tool = result.data.tools.find((tool) => tool.name === upload.tool?.name)
            if (upload.tool && !tool) {
              setUpload(undefined)
              toast.info("This tool has been deleted")
              return
            }
            setUpload({ tool, version: result.data.resource_version })
          }}
        />
      ) : null}

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(undefined)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.tool.name}?</DialogTitle>
            <DialogDescription>
              The agent will stop offering this tool after its runtime updates. This restarts the
              runtime and can interrupt active work.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm">
            <p className="font-mono">{deleting?.tool.filename}</p>
            <p className="text-muted-foreground">{deleting?.tool.description}</p>
          </div>
          {deleteError ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                {deleteError}
                <Button
                  disabled={pending}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    startTransition(async () => {
                      const result = await query.refetch()
                      if (!result.isSuccess) {
                        setDeleteError(result.error?.message ?? "Tools could not be refreshed.")
                        return
                      }
                      const tool = result.data.tools.find(
                        (tool) => tool.name === deleting?.tool.name
                      )
                      setDeleting(
                        tool ? { tool, version: result.data.resource_version } : undefined
                      )
                      setDeleteError(undefined)
                    })
                  }}
                >
                  <RefreshCw aria-hidden="true" /> Reload tool
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button disabled={pending} onClick={() => setDeleting(undefined)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={pending}
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                startTransition(async () => {
                  try {
                    const result = await deleteAgentToolAction(
                      workspaceId,
                      agentName,
                      deleting.tool.name,
                      deleting.version
                    )
                    if (result.error) {
                      setDeleteError(result.error.message)
                      return
                    }
                    await saved(result.data)
                    setDeleting(undefined)
                    toast.success("Tool deleted")
                  } catch {
                    setDeleteError(
                      "Deletion could not be confirmed. Refresh the tools before trying again."
                    )
                  }
                })
              }}
            >
              {pending ? <Spinner aria-hidden="true" /> : <Trash2 aria-hidden="true" />} Delete tool
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ToolUpload({
  agentName,
  workspaceId,
  existing,
  version,
  onClose,
  onSaved,
  onReload,
}: {
  agentName: string
  workspaceId: string
  existing?: AgentTool
  version: string
  onClose: () => void
  onSaved: (config: ToolConfiguration) => Promise<void>
  onReload: () => Promise<void>
}) {
  const form = useForm<AgentTool>({
    resolver: zodResolver(zAgentTool),
    defaultValues: existing ?? {
      name: "",
      description: "",
      language: "bash",
      filename: "",
      script: "",
      inputs: [],
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
  })
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "inputs" })
  const [file, language, script] = useWatch({
    control: form.control,
    name: ["filename", "language", "script"],
  })
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState<string>()
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [pending, startTransition] = useTransition()
  const selection = useRef(0)

  useEffect(() => {
    if (!form.formState.isDirty) return
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [form.formState.isDirty])

  function close() {
    if (pending || reading) return
    if (form.formState.isDirty) {
      setDiscard(true)
      return
    }
    onClose()
  }

  async function chooseFile(next: File) {
    const current = ++selection.current
    setReading(false)
    setFileError(undefined)
    const extension = next.name.slice(next.name.lastIndexOf(".")).toLowerCase()
    let nextLanguage: AgentTool["language"]
    switch (extension) {
      case ".sh":
        nextLanguage = "bash"
        break
      case ".py":
        nextLanguage = "python"
        break
      case ".js":
        nextLanguage = "node"
        break
      default:
        setFileError("Upload a .sh, .py, or .js script.")
        return
    }
    if (next.size > 64 * 1024) {
      setFileError("Scripts must be 64 KiB or smaller.")
      return
    }
    setReading(true)
    try {
      const script = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await next.arrayBuffer()
      )
      if (current !== selection.current) return
      if (!script.trim() || script.includes("\0")) {
        setFileError("Upload a nonempty text script without NUL bytes.")
        return
      }
      form.setValue("script", script, { shouldDirty: true, shouldValidate: true })
      form.setValue("filename", next.name, { shouldDirty: true, shouldValidate: true })
      form.setValue("language", nextLanguage, { shouldDirty: true })
    } catch {
      if (current === selection.current) setFileError("The file could not be read as UTF-8 text.")
    } finally {
      if (current === selection.current) setReading(false)
    }
  }

  const submit = form.handleSubmit((tool) => {
    if (fileError || reading) return
    setError(undefined)
    setConflict(false)
    startTransition(async () => {
      try {
        const result = await saveAgentToolAction(
          workspaceId,
          agentName,
          version,
          tool,
          existing !== undefined
        )
        if (result.error) {
          setConflict(result.error.code === "conflict")
          setError(
            result.error.message +
              (result.error.errors?.map((field) => `\n${field.field}: ${field.message}`).join("") ??
                "")
          )
          return
        }
        await onSaved(result.data)
        toast.success(existing ? "Tool updated" : "Tool uploaded")
      } catch {
        setError(
          "The upload could not be confirmed. Your changes are still here; refresh the tools before trying again."
        )
      }
    })
  })

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent
        className="h-full overflow-hidden sm:w-[50vw]! sm:max-w-none!"
        onEscapeKeyDown={(event) => {
          if (discard) event.preventDefault()
        }}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>{existing ? "Edit tool" : "Create tool"}</SheetTitle>
          <SheetDescription>
            {existing
              ? "Upload a replacement script or update how the agent calls this tool."
              : "Upload a script and describe when the agent should use it."}
          </SheetDescription>
        </SheetHeader>
        <form
          id="tool-upload"
          onSubmit={submit}
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
        >
          <FieldSet disabled={pending}>
            <FieldGroup>
              <Field data-invalid={!!form.formState.errors.name}>
                <FieldLabel htmlFor="tool-name" required>
                  Tool name
                </FieldLabel>
                <Input
                  id="tool-name"
                  {...form.register("name")}
                  readOnly={existing !== undefined}
                  placeholder="lookup_customer"
                  aria-invalid={!!form.formState.errors.name}
                />
                <FieldDescription>
                  Lowercase letters, numbers, and underscores. Start with a letter.
                </FieldDescription>
                <FieldError>
                  {form.formState.errors.name &&
                    "Use up to 64 lowercase letters, numbers, or underscores, starting with a letter."}
                </FieldError>
              </Field>
              <Field data-invalid={!!fileError || !!form.formState.errors.script}>
                <FieldLabel htmlFor="tool-file" required={!existing}>
                  Script file
                </FieldLabel>
                <label
                  className="border-muted-foreground/50 bg-muted/10 hover:border-muted-foreground focus-within:border-ring focus-within:ring-ring/50 data-[dragging=true]:border-primary data-[dragging=true]:bg-primary/10 flex min-h-28 cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed p-5 transition-colors focus-within:ring-3 in-disabled:cursor-default in-disabled:opacity-50"
                  data-dragging={dragging}
                  onDragEnter={(event) => {
                    if (pending || !event.dataTransfer.types.includes("Files")) return
                    event.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDragOver={(event) => {
                    if (pending || !event.dataTransfer.types.includes("Files")) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = "copy"
                    setDragging(true)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    if (pending) return
                    if (event.dataTransfer.files.length !== 1) {
                      setFileError("Upload one script at a time.")
                      return
                    }
                    const next = event.dataTransfer.files[0]
                    if (next) void chooseFile(next)
                  }}
                >
                  {reading ? (
                    <Spinner aria-hidden="true" />
                  ) : (
                    <Upload className="text-muted-foreground size-6 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {reading ? "Reading script…" : file || "Choose or drop a script"}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      .sh, .py, .js · up to 64 KiB
                    </span>
                  </span>
                  <input
                    id="tool-file"
                    className="sr-only"
                    type="file"
                    accept=".sh,.py,.js"
                    onChange={(event) => {
                      const next = event.target.files?.[0]
                      if (next) void chooseFile(next)
                      event.target.value = ""
                    }}
                    aria-invalid={!!fileError || !!form.formState.errors.script}
                  />
                </label>
                <FieldDescription>
                  {file
                    ? `${language === "node" ? "Node.js" : language === "python" ? "Python 3" : "Bash"} · ${new TextEncoder().encode(script).length.toLocaleString()} bytes`
                    : "The file extension selects the interpreter."}
                </FieldDescription>
                <FieldError>
                  {fileError ??
                    (form.formState.errors.script && "Choose a script file.") ??
                    form.formState.errors.filename?.message}
                </FieldError>
              </Field>
            </FieldGroup>
            <Field data-invalid={!!form.formState.errors.description}>
              <FieldLabel htmlFor="tool-description" required>
                Description
              </FieldLabel>
              <Textarea
                id="tool-description"
                {...form.register("description")}
                rows={2}
                placeholder="Look up a customer by email and return their account details."
                aria-invalid={!!form.formState.errors.description}
              />
              <FieldDescription>Tell the agent when to use this tool.</FieldDescription>
              <FieldError>
                {form.formState.errors.description && "Describe this tool in 1 to 4096 characters."}
              </FieldError>
            </Field>
            <section className="flex flex-col gap-4" aria-label="Tool inputs">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">Inputs</h3>
                  <p className="text-muted-foreground text-xs">
                    Arguments the agent provides to your script.
                  </p>
                </div>
                <Button
                  disabled={fields.length >= 32}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() =>
                    append({ name: "", description: "", type: "string", required: true })
                  }
                >
                  <Plus aria-hidden="true" /> Add input
                </Button>
              </div>
              {fields.map((field, index) => (
                <FieldGroup key={field.id} className="bg-primary/3 gap-3 rounded-lg p-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_8rem_2rem] items-start gap-2">
                    <Field
                      className="min-w-0"
                      data-invalid={!!form.formState.errors.inputs?.[index]?.name}
                    >
                      <FieldLabel
                        htmlFor={`input-${field.id}`}
                        className="text-muted-foreground text-xs"
                      >
                        Name<span className="sr-only"> for input {index + 1}</span>
                      </FieldLabel>
                      <Input
                        id={`input-${field.id}`}
                        className="font-mono"
                        {...form.register(`inputs.${index}.name`)}
                        placeholder="email"
                        aria-invalid={!!form.formState.errors.inputs?.[index]?.name}
                      />
                      <FieldError>
                        {form.formState.errors.inputs?.[index]?.name &&
                          "Use up to 64 lowercase letters, numbers, or underscores, starting with a letter."}
                      </FieldError>
                    </Field>
                    <Controller
                      control={form.control}
                      name={`inputs.${index}.type`}
                      render={({ field: input }) => (
                        <Field>
                          <FieldLabel
                            htmlFor={`type-${field.id}`}
                            className="text-muted-foreground text-xs"
                          >
                            Type
                          </FieldLabel>
                          <Select value={input.value} onValueChange={input.onChange}>
                            <SelectTrigger
                              id={`type-${field.id}`}
                              className="text-primary bg-primary/5 dark:bg-primary/10 w-full"
                              aria-label={`Input ${index + 1} type`}
                              onBlur={input.onBlur}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {inputTypes.map((type) => (
                                  <SelectItem key={type.value} value={type.value}>
                                    <type.icon aria-hidden="true" />
                                    {type.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    />
                    <Button
                      className="mt-6"
                      size="icon"
                      type="button"
                      variant="destructive"
                      aria-label={`Remove input ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel
                        className="text-muted-foreground text-xs"
                        htmlFor={`description-${field.id}`}
                      >
                        Description<span className="sr-only"> for input {index + 1}</span>
                      </FieldLabel>
                      <Controller
                        control={form.control}
                        name={`inputs.${index}.required`}
                        render={({ field: input }) => (
                          <div className="flex items-center gap-2">
                            <Switch
                              id={`required-${field.id}`}
                              checked={input.value}
                              onCheckedChange={input.onChange}
                              onBlur={input.onBlur}
                            />
                            <FieldLabel
                              htmlFor={`required-${field.id}`}
                              className="text-xs font-normal"
                            >
                              Required
                            </FieldLabel>
                          </div>
                        )}
                      />
                    </div>
                    <Textarea
                      id={`description-${field.id}`}
                      rows={2}
                      {...form.register(`inputs.${index}.description`)}
                      className="min-h-0 resize-y"
                      placeholder="How the agent should choose this value"
                    />
                    <FieldError errors={[form.formState.errors.inputs?.[index]?.description]} />
                  </Field>
                </FieldGroup>
              ))}
              <FieldError errors={[form.formState.errors.inputs]} />
            </section>
          </FieldSet>
          <details className="text-xs">
            <summary className="cursor-pointer font-medium">Script input and output</summary>
            <p className="text-muted-foreground mt-3">
              Your script receives input through stdin as JSON. With no inputs, stdin contains{" "}
              {"{}"}.
            </p>
            <p className="text-muted-foreground mt-3">
              For e.g., a weather tool with a Text input named city receives:
            </p>
            <pre className="bg-muted mt-2 overflow-auto rounded-md p-3">
              <code>{'{"city":"Mumbai"}'}</code>
            </pre>
            <p className="text-muted-foreground mt-3">Print the tool result to stdout.</p>
            <pre className="bg-muted mt-3 overflow-auto rounded-md p-3">
              <code>{examples[language]}</code>
            </pre>
          </details>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Tool could not be saved</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">
                {error}
                {conflict ? (
                  <>
                    <p>Reloading replaces your unsaved changes with the latest definition.</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        startTransition(async () => {
                          try {
                            await onReload()
                          } catch {
                            setError("Tools could not be refreshed. Your changes are still here.")
                          }
                        })
                      }}
                    >
                      <RefreshCw aria-hidden="true" /> Reload tools
                    </Button>
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </form>
        <SheetFooter className="shrink-0 flex-row justify-end border-t">
          <Button disabled={pending || reading} onClick={close} variant="outline">
            Cancel
          </Button>
          <Button disabled={pending || reading || !!fileError} form="tool-upload" type="submit">
            {pending || reading ? (
              <Spinner aria-hidden="true" />
            ) : existing ? (
              <Pencil aria-hidden="true" />
            ) : (
              <Wrench aria-hidden="true" />
            )}
            {pending ? "Saving…" : existing ? "Save changes" : "Create tool"}
          </Button>
        </SheetFooter>
        {/* Nesting keeps discard clicks from dismissing the editor. */}
        <Dialog open={discard} onOpenChange={setDiscard}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Discard changes?</DialogTitle>
              <DialogDescription>
                Your upload and form changes have not been saved.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setDiscard(false)} variant="outline">
                Keep editing
              </Button>
              <Button onClick={onClose} variant="destructive">
                Discard changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}
