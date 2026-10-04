"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  FileCode2,
  Plus,
  RefreshCw,
  Replace,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { deleteAgentToolAction, saveAgentToolAction } from "@/data/agent.actions"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  listAgentTools,
  type AgentTool,
  type AgentTools as ToolConfiguration,
  type ToolInputType,
} from "@/lib/gateway/client"
import { zAgentTool } from "@/lib/gateway/client/zod.gen"

const inputTypes = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Boolean" },
  { value: "json", label: "JSON" },
] satisfies { value: ToolInputType; label: string }[]

const examples = {
  bash: `input=$(cat)
printf '%s\\n' "$input"`,
  python: `import json, sys
args = json.load(sys.stdin)
print(json.dumps(args))`,
  node: `const fs = require("node:fs")
const args = JSON.parse(fs.readFileSync(0, "utf8"))
console.log(JSON.stringify(args))`,
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
  const [upload, setUpload] = useState<{ tool?: AgentTool; version: string }>()
  const [deleting, setDeleting] = useState<{ tool: AgentTool; version: string }>()
  const [deleteError, setDeleteError] = useState<string>()
  const [pending, startTransition] = useTransition()

  async function saved(next: ToolConfiguration) {
    await client.cancelQueries({ queryKey })
    client.setQueryData(queryKey, next)
    setUpload(undefined)
  }

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 md:px-6">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">Custom tools</h2>
          <p className="text-muted-foreground text-sm">
            Give this agent a script it can call during a conversation.
          </p>
        </div>
        <Button
          disabled={config.tools.length >= 32}
          onClick={() => setUpload({ version: config.resource_version })}
        >
          <Upload aria-hidden="true" /> Upload tool
        </Button>
      </div>

      {!config.applied || query.error ? (
        <Alert
          className="mx-4 w-auto md:mx-6"
          variant={query.error || config.status === "DEGRADED" ? "destructive" : "default"}
        >
          {query.error || config.status === "DEGRADED" ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <Spinner aria-hidden="true" />
          )}
          <AlertTitle>
            {query.error
              ? "Tools could not be refreshed"
              : config.status === "DEGRADED"
                ? "Tools could not be applied"
                : "Applying tools"}
          </AlertTitle>
          <AlertDescription>
            {query.error?.message ?? config.message}
            <Button
              className="mt-2 w-fit"
              onClick={() => void query.refetch()}
              size="sm"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" /> Refresh
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {config.tools.length === 0 ? (
        <Empty className="mx-4 min-h-64 w-auto border md:mx-6">
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
            <Upload aria-hidden="true" /> Upload tool
          </Button>
        </Empty>
      ) : (
        <div className="border-b">
          <Table aria-label="Custom tools">
            <TableHeader>
              <TableRow>
                <TableHead className="px-4 md:px-6">Tool</TableHead>
                <TableHead>Script</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {config.tools.map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell className="max-w-64 px-4 py-4 whitespace-normal md:px-6">
                    <div className="flex items-center gap-2">
                      <FileCode2
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="font-mono text-sm break-all">{tool.name}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                      {tool.description}
                    </p>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {tool.inputs.length === 0
                        ? "No inputs"
                        : `${tool.inputs.length} input${tool.inputs.length === 1 ? "" : "s"}`}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    <Badge variant="secondary">
                      {tool.language === "node"
                        ? "Node.js"
                        : tool.language === "python"
                          ? "Python"
                          : "Bash"}
                    </Badge>
                    <p
                      className="text-muted-foreground mt-1 truncate text-xs"
                      title={tool.filename}
                    >
                      {tool.filename}
                    </p>
                  </TableCell>
                  <TableCell className="px-4 text-right md:px-6">
                    <div className="flex justify-end gap-1">
                      <Button
                        aria-label={`Replace ${tool.name}`}
                        onClick={() => setUpload({ tool, version: config.resource_version })}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Replace aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={`Delete ${tool.name}`}
                        onClick={() => {
                          setDeleting({ tool, version: config.resource_version })
                          setDeleteError(undefined)
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-muted-foreground px-4 text-xs md:px-6">
        Tools are available to everyone using this agent. Scripts use its sandbox packages and
        existing access.
      </p>

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
                    if (result.data) {
                      await saved(result.data)
                      setDeleting(undefined)
                      toast.success("Tool deleted")
                    }
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
      form.setValue("filename", next.name, { shouldDirty: true })
      form.setValue("language", nextLanguage, { shouldDirty: true })
      form.clearErrors("script")
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
        if (result.data) {
          await onSaved(result.data)
          toast.success(existing ? "Tool updated" : "Tool uploaded")
        }
      } catch {
        setError(
          "The upload could not be confirmed. Your changes are still here; refresh the tools before trying again."
        )
      }
    })
  })

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent
          className="sm:max-w-2xl"
          onEscapeKeyDown={(event) => {
            if (discard) event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? "Replace tool" : "Upload tool"}</DialogTitle>
            <DialogDescription>
              {existing
                ? "Upload a replacement script or update how the agent calls this tool."
                : "Upload a script and describe when the agent should use it."}
            </DialogDescription>
          </DialogHeader>
          <form id="tool-upload" onSubmit={submit} className="space-y-5">
            <fieldset disabled={pending} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
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
                <Field>
                  <FieldLabel htmlFor="tool-file" required={!existing}>
                    Script file
                  </FieldLabel>
                  <label
                    className="hover:border-ring focus-within:ring-ring/50 flex min-h-20 cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 focus-within:ring-3"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
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
                      <Upload
                        className="text-muted-foreground size-5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm">
                        {reading ? "Reading script…" : file || "Choose or drop a script"}
                      </span>
                      <span className="text-muted-foreground text-xs">
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
              </div>
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
                <FieldDescription>
                  Tell the agent when to use this tool and what it returns.
                </FieldDescription>
                <FieldError>
                  {form.formState.errors.description &&
                    "Describe this tool in 1 to 4096 characters."}
                </FieldError>
              </Field>
              <section className="space-y-3" aria-label="Tool inputs">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-medium">
                      Inputs <span className="text-muted-foreground font-normal">Optional</span>
                    </h3>
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
                  <div key={field.id} className="space-y-3 rounded-lg border p-3">
                    <div className="flex items-start gap-2">
                      <Field className="min-w-0 flex-1">
                        <FieldLabel htmlFor={`input-${field.id}`} className="sr-only">
                          Input {index + 1} name
                        </FieldLabel>
                        <Input
                          id={`input-${field.id}`}
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
                        render={({ field }) => (
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger
                              className="w-28"
                              aria-label={`Input ${index + 1} type`}
                              onBlur={field.onBlur}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {inputTypes.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  {type.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <Button
                        size="icon"
                        type="button"
                        variant="ghost"
                        aria-label={`Remove input ${index + 1}`}
                        onClick={() => remove(index)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                    <Field>
                      <FieldLabel className="sr-only" htmlFor={`description-${field.id}`}>
                        Input {index + 1} description
                      </FieldLabel>
                      <Input
                        id={`description-${field.id}`}
                        {...form.register(`inputs.${index}.description`)}
                        placeholder="How the agent should choose this value"
                      />
                      <FieldError errors={[form.formState.errors.inputs?.[index]?.description]} />
                    </Field>
                    <Controller
                      control={form.control}
                      name={`inputs.${index}.required`}
                      render={({ field: input }) => (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`required-${field.id}`}
                            checked={input.value}
                            onCheckedChange={(checked) => input.onChange(checked === true)}
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
                ))}
                <FieldError errors={[form.formState.errors.inputs]} />
              </section>
            </fieldset>
            <details className="rounded-lg border p-3 text-xs">
              <summary className="cursor-pointer font-medium">
                How your script receives inputs
              </summary>
              <p className="text-muted-foreground mt-3">
                Read a JSON object from stdin and write the result to stdout. A tool without inputs
                receives {"{}"}. Additional packages come from the agent’s sandbox.
              </p>
              <pre className="bg-muted mt-3 overflow-auto rounded-md p-3">
                <code>{examples[language]}</code>
              </pre>
              <Button
                className="mt-2"
                size="sm"
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(examples[language])
                    toast.success("Example copied")
                  } catch {
                    toast.error("Could not copy the example")
                  }
                }}
              >
                Copy example
              </Button>
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
            <p className="text-muted-foreground text-xs">
              Saving restarts this agent’s runtime and can interrupt active work.
            </p>
          </form>
          <DialogFooter>
            <Button disabled={pending || reading} onClick={close} variant="outline">
              Cancel
            </Button>
            <Button disabled={pending || reading || !!fileError} form="tool-upload" type="submit">
              {pending || reading ? <Spinner aria-hidden="true" /> : <Upload aria-hidden="true" />}
              {pending ? "Saving…" : existing ? "Save changes" : "Upload tool"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>Your upload and form changes have not been saved.</DialogDescription>
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
    </>
  )
}
