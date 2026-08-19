"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { useSearchParams } from "next/navigation"
import type { UrlObject } from "node:url"
import { queryOptions, useQuery } from "@tanstack/react-query"
import type { ColumnDef, SortingState } from "@tanstack/react-table"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { zodResolver } from "@hookform/resolvers/zod"
import { defineStepper } from "@stepperize/react"
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Brain,
  Cable,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Globe2,
  Layers3,
  ScrollText,
  PackageSearch as PackageSearchIcon,
  Plus,
  RefreshCw,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react"
import * as React from "react"
import { startTransition, useActionState, useRef, useState } from "react"
import { toast } from "sonner"
import { Controller, useForm, useWatch } from "react-hook-form"
import { formatCompactNumber } from "@/lib/format"
import { WizardShell } from "@/components/blocks/wizard/shell"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TablePagination } from "@/components/table-pagination"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RelativeDateTime } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  createSandboxFormAction,
  updateSandboxFormAction,
  type SandboxActionScope,
} from "@/data/sandbox.actions"
import type { CreateSandboxFormState } from "@/data/types"
import { refreshInferenceProvidersAction } from "@/data/inference-provider.actions"
import { refreshInferencePoolsAction } from "@/data/inference-pool.actions"
import * as z from "zod"
import { sandboxAllowedHostSchema, sandboxNameSchema } from "@/data/schema"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  getMcpConnection,
  listMcpConnections,
  listSkills,
  type ImmutableSkillSortByQuery,
  type McpConnectionSummary,
  type InferenceProvider,
  type InferencePool,
  type SandboxInference,
  type SandboxInferenceModelRef,
  type ResourceReference,
  type ResourceSortByQuery,
  type SecretHost,
  type Skill,
} from "@/lib/gateway/client"
import {
  zMcpConnectionName,
  zResourceReference,
  zResourceScope,
} from "@/lib/gateway/client/zod.gen"
import { renderMcpServerIcon } from "@/app/(app)/mcps/catalog"
import { ProviderIcon, providerKindLabels } from "@/app/(app)/inference/providers/provider-shared"
import { PackageSearch } from "./package-search"
import { useServerSorting } from "@/lib/use-token-pagination"

type SandboxWizardMode = "create" | "update"

const identitySchema = z.object({
  name: sandboxNameSchema,
})

const selectedMcpToolSchema = z.object({
  name: z.string({ error: "MCP tool name is required" }).min(1, "MCP tool name is required"),
  requireConsent: z.boolean({ error: "MCP tool consent setting is required" }),
})

const selectedMcpConnectionRefSchema = z.object({
  scope: zResourceScope,
  name: z
    .string({ error: "MCP connection name is required" })
    .min(1, "MCP connection name is required")
    .pipe(zMcpConnectionName),
  tools: z.array(selectedMcpToolSchema, { error: "MCP tools must be a list" }),
})

const allowedHostsStepSchema = z.object({
  allowedHosts: z
    .array(sandboxAllowedHostSchema)
    .transform((hosts) => Array.from(new Set(hosts)).sort()),
})

const packageStepSchema = z.object({
  packages: z.array(
    z.string({ error: "Package name is required" }).min(1, "Package name is required"),
    { error: "Packages must be a list" }
  ),
})

const mcpStepSchema = z.object({
  mcpConnectionRefs: z.array(selectedMcpConnectionRefSchema, {
    error: "MCP connections must be a list",
  }),
})

const skillsStepSchema = z.object({
  skills: z.array(zResourceReference, { error: "Skills must be a list" }),
})

type SandboxIdentity = z.infer<typeof identitySchema>
type SelectedMcpTool = z.infer<typeof selectedMcpToolSchema>
type SelectedMcpConnectionRef = z.infer<typeof selectedMcpConnectionRefSchema>
type PackageStepValues = z.infer<typeof packageStepSchema>
type McpStepValues = z.infer<typeof mcpStepSchema>
type SkillsStepValues = z.infer<typeof skillsStepSchema>
type AllowedHostsStepValues = z.infer<typeof allowedHostsStepSchema>

type SandboxWizardData = {
  identity?: SandboxIdentity
  packages?: string[]
  mcps?: SelectedMcpConnectionRef[]
  skills?: ResourceReference[]
  inference?: SandboxInference
  allowedHosts?: AllowedHostsDraft
}

type AllowedHostsDraft = AllowedHostsStepValues & {
  draft: string
}

type SandboxWizardProps = {
  initialName?: string
  initialAllowedHosts?: string[]
  initialMcpConnectionRefs?: SelectedMcpConnectionRef[]
  initialPackages?: string[]
  initialSkills?: ResourceReference[]
  initialInference?: SandboxInference
  immutableSkills: Skill[]
  immutableSkillsNextPageToken: string
  mcpConnections: McpConnectionSummary[]
  mcpConnectionsNextPageToken: string
  inferenceProviders: InferenceProvider[]
  inferencePools: InferencePool[]
  mode: SandboxWizardMode
  providersHref: UrlObject
  scope: SandboxActionScope
  secretHostSuggestions?: Promise<SecretHost[]>
}

type PackageStepProps = {
  installedPackages: string[]
  selectedPackages: string[]
  onAdvanceAction: () => void
  onPrev: () => void
  onNext: (packages: string[]) => void
}

type AllowedHostsStepProps = {
  identity: SandboxIdentity
  initialAllowedHosts: string[]
  initialDraft: string
  mcpConnectionRefs: SelectedMcpConnectionRef[]
  packages: string[]
  skills: ResourceReference[]
  inference: SandboxInference
  mode: SandboxWizardMode
  scope: SandboxActionScope
  secretHostSuggestions?: Promise<SecretHost[]>
  onAllowedHostsChangeAction: (data: AllowedHostsDraft) => void
  onPrev: () => void
}

type ModelsStepProps = {
  inferenceProviders: InferenceProvider[]
  inferencePools: InferencePool[]
  inference?: SandboxInference
  providersHref: UrlObject
  scope: SandboxActionScope
  onAdvanceAction: () => void
  onChangeAction: (inference?: SandboxInference) => void
  onNext: () => void
  onPrev: () => void
}

type SkillsStepProps = {
  immutableSkills: Skill[]
  initialNextPageToken: string
  initialSkills: ResourceReference[]
  workspaceId?: string
  onAdvanceAction: () => void
  onNext: (skills: ResourceReference[]) => void
  onPrev: () => void
}

type McpStepProps = {
  initialMcpConnectionRefs: SelectedMcpConnectionRef[]
  initialNextPageToken: string
  mcpConnections: McpConnectionSummary[]
  workspaceId?: string
  onAdvanceAction: () => void
  onNext: (mcpConnectionRefs: SelectedMcpConnectionRef[]) => void
  onPrev: () => void
}

const formIdByStep = {
  identity: "sandbox-form-identity",
  packages: "sandbox-form-packages",
  mcps: "sandbox-form-mcps",
  skills: "sandbox-form-skills",
  models: "sandbox-form-models",
  allowedHosts: "sandbox-form-allowed-hosts",
} as const

type StepId = (typeof steps)[number]["id"]

type NavigationRequest = { kind: "prev" } | { kind: "step"; step: StepId; index: number }

const mcpLayout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 160, contentMaxWidth: 256 },
  auth_mode: { minWidth: 128, width: 128 },
  endpoint: { minWidth: 224, contentMaxWidth: 320 },
  age: { minWidth: 112, width: 112 },
  attach: { minWidth: 56, width: 56 },
}

const skillLayout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  version: { minWidth: 112, width: 112 },
  modified: { minWidth: 128, width: 128 },
  attach: { minWidth: 56, width: 56 },
}

type CursorPage<T> = {
  rows: T[]
  nextPageToken: string
}

function useCursorPage<T>(
  initialRows: T[],
  initialNextPageToken: string,
  loadPage: (pageToken?: string) => Promise<CursorPage<T>>,
  refreshKey: string,
  initialKey: string
) {
  const [page, setPage] = React.useState({
    currentPageToken: "",
    nextPageToken: initialNextPageToken,
    rows: initialRows,
  })
  const [previousPageTokens, setPreviousPageTokens] = React.useState<string[]>([])
  const [error, setError] = React.useState<globalThis.Error>()
  const [pending, startTransition] = React.useTransition()
  const loadedKey = React.useRef(initialKey)

  React.useEffect(() => {
    if (loadedKey.current === refreshKey) return
    loadedKey.current = refreshKey
    startTransition(async () => {
      try {
        const first = await loadPage()
        setPage({ ...first, currentPageToken: "" })
        setPreviousPageTokens([])
        setError(undefined)
      } catch {
        setError(new globalThis.Error("Could not sort this table."))
      }
    })
  }, [loadPage, refreshKey])

  const goNext = () => {
    if (!page.nextPageToken) return
    const nextPageToken = page.nextPageToken
    startTransition(async () => {
      try {
        const next = await loadPage(nextPageToken)
        setPreviousPageTokens((tokens) => [...tokens, page.currentPageToken])
        setPage({ ...next, currentPageToken: nextPageToken })
        setError(undefined)
      } catch {
        setError(new globalThis.Error("Could not load the next page."))
      }
    })
  }

  const goPrevious = () => {
    const previousPageToken = previousPageTokens.at(-1)
    if (previousPageToken === undefined) return
    startTransition(async () => {
      try {
        const previous = await loadPage(previousPageToken || undefined)
        setPreviousPageTokens((tokens) => tokens.slice(0, -1))
        setPage({ ...previous, currentPageToken: previousPageToken })
        setError(undefined)
      } catch {
        setError(new globalThis.Error("Could not load the previous page."))
      }
    })
  }

  return {
    canGoNext: Boolean(page.nextPageToken),
    canGoPrevious: previousPageTokens.length > 0,
    error,
    goNext,
    goPrevious,
    pending,
    rows: page.rows,
  }
}

const steps = [
  {
    id: "identity",
    title: "Identity",
    icon: Box,
  },
  {
    id: "packages",
    title: "Packages",
    icon: PackageSearchIcon,
  },
  {
    id: "mcps",
    title: "MCP",
    icon: Cable,
  },
  {
    id: "skills",
    title: "Skills",
    icon: ScrollText,
  },
  {
    id: "models",
    title: "Models",
    icon: Brain,
  },
  {
    id: "allowedHosts",
    title: "Allowed hosts",
    icon: Globe2,
  },
] as const

const { Stepper } = defineStepper(...steps)

function IdentityForm({
  defaultValues,
  lockName,
  onAdvanceAction,
  onNext,
}: {
  defaultValues: SandboxIdentity
  lockName: boolean
  onAdvanceAction: () => void
  onNext: (data: SandboxIdentity) => void
}) {
  const form = useForm<SandboxIdentity>({
    resolver: zodResolver(identitySchema),
    defaultValues,
  })

  return (
    <form
      id="sandbox-form-identity"
      onSubmit={form.handleSubmit(onNext)}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
    >
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid} data-disabled={lockName}>
              <FieldLabel htmlFor="sandbox-form-name" required>
                Name
              </FieldLabel>
              <Input
                id="sandbox-form-name"
                name={field.name}
                ref={field.ref}
                value={field.value}
                onBlur={field.onBlur}
                onChange={field.onChange}
                disabled={lockName}
                readOnly={lockName}
                autoFocus
                autoComplete="off"
                placeholder="my-sandbox"
                aria-invalid={fieldState.invalid}
                aria-required="true"
              />
              <FieldDescription>
                {lockName
                  ? "Sandbox name cannot be changed."
                  : "Lowercase letters, numbers, and hyphens only. Max 32 characters."}
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <StepActions>
        <Button type="submit" onClick={onAdvanceAction} disabled={form.formState.isSubmitting}>
          Next
          {form.formState.isSubmitting ? (
            <Spinner data-icon="inline-end" />
          ) : (
            <ArrowRight data-icon="inline-end" />
          )}
        </Button>
      </StepActions>
    </form>
  )
}

function PackageStep({
  installedPackages,
  selectedPackages,
  onAdvanceAction,
  onNext,
  onPrev,
}: PackageStepProps) {
  const form = useForm<PackageStepValues>({
    resolver: zodResolver(packageStepSchema),
    defaultValues: {
      packages: selectedPackages,
    },
  })
  const selected = useWatch({
    control: form.control,
    name: "packages",
    defaultValue: selectedPackages,
  })

  return (
    <form
      id={formIdByStep.packages}
      onSubmit={form.handleSubmit((data) => onNext(data.packages))}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
    >
      <PackageSearch
        installed={installedPackages}
        selected={selected}
        onSelectedChangeAction={(packages) =>
          form.setValue("packages", packages, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
      />
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button type="submit" onClick={onAdvanceAction} disabled={form.formState.isSubmitting}>
          Next
          {form.formState.isSubmitting ? (
            <Spinner data-icon="inline-end" />
          ) : (
            <ArrowRight data-icon="inline-end" />
          )}
        </Button>
      </StepActions>
    </form>
  )
}

function createMcpSelectionColumns({
  expandedReferences,
  selectedReferences,
  onExpandedChange,
  onSelectedChange,
}: {
  expandedReferences: ReadonlySet<string>
  selectedReferences: ReadonlySet<string>
  onExpandedChange: (reference: string) => void
  onSelectedChange: (connection: McpConnectionSummary, checked: boolean) => void
}): ColumnDef<McpConnectionSummary>[] {
  return [
    {
      accessorKey: "name",
      enableSorting: true,
      header: "Name",
      cell: ({ row }) => {
        const connection = row.original
        const reference = JSON.stringify([connection.scope, connection.name])

        return (
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => onExpandedChange(reference)}
          >
            <ChevronDown
              className={`size-4 shrink-0 transition-transform ${expandedReferences.has(reference) ? "rotate-180" : ""}`}
            />
            <div className="flex min-w-0 items-center gap-2">
              {renderMcpServerIcon(connection.endpoint_url, {
                "aria-hidden": "true",
                className: "size-4 shrink-0",
              })}
              <span className="min-w-0 truncate font-medium">{connection.name}</span>
              <Badge variant="outline">{connection.scope}</Badge>
            </div>
          </button>
        )
      },
    },
    {
      id: "auth_mode",
      header: () => <span className="text-foreground">Auth type</span>,
      accessorFn: (row) => row.auth_mode.toLowerCase(),
      cell: ({ row }) => <span className="capitalize">{row.original.auth_mode.toLowerCase()}</span>,
    },
    {
      id: "endpoint",
      header: () => <span className="text-foreground">Endpoint</span>,
      accessorFn: (row) => row.endpoint_url,
      cell: ({ row }) => (
        <span
          className="text-muted-foreground block min-w-0 truncate"
          title={row.original.endpoint_url}
        >
          {row.original.endpoint_url}
        </span>
      ),
    },
    {
      id: "age",
      accessorKey: "created_at",
      enableSorting: true,
      header: "Age",
      cell: ({ row }) => <RelativeDateTime value={row.original.created_at} />,
    },
    {
      id: "attach",
      header: "",
      accessorFn: (row) => selectedReferences.has(JSON.stringify([row.scope, row.name])),
      cell: ({ row }) => {
        const connection = row.original
        const selected = selectedReferences.has(JSON.stringify([connection.scope, connection.name]))
        const disabled = !connection.tool_catalog_ready && !selected

        return (
          <div className="flex justify-end">
            <Switch
              checked={selected}
              aria-label={`Attach ${connection.name}`}
              disabled={disabled}
              onCheckedChange={(checked) => onSelectedChange(connection, checked)}
            />
          </div>
        )
      },
    },
  ]
}

function createSkillSelectionColumns({
  selectedReferences,
  onSelectedChange,
}: {
  selectedReferences: ReadonlySet<string>
  onSelectedChange: (skill: Skill, checked: boolean) => void
}): ColumnDef<Skill>[] {
  return [
    {
      accessorKey: "name",
      enableSorting: true,
      header: "Name",
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="block min-w-0 truncate font-medium" title={row.original.name}>
            {row.original.name}
          </span>
          <Badge variant="outline">{row.original.scope}</Badge>
        </div>
      ),
    },
    {
      id: "version",
      accessorKey: "version",
      enableSorting: true,
      header: "Version",
      cell: ({ row }) => `v${row.original.version}`,
    },
    {
      id: "attach",
      header: "",
      accessorFn: (row) => selectedReferences.has(JSON.stringify([row.scope, row.name])),
      cell: ({ row }) => {
        const skill = row.original
        const selected = selectedReferences.has(JSON.stringify([skill.scope, skill.name]))

        return (
          <div className="flex justify-end">
            <Switch
              checked={selected}
              aria-label={`Attach ${skill.name}`}
              onCheckedChange={(checked) => onSelectedChange(skill, checked)}
            />
          </div>
        )
      },
    },
  ]
}

function McpToolsPanel({
  connection,
  selectedRef,
  onToolsChange,
  workspaceId,
}: {
  connection: McpConnectionSummary
  selectedRef?: SelectedMcpConnectionRef
  onToolsChange: (
    scope: McpConnectionSummary["scope"],
    name: string,
    tools: SelectedMcpTool[]
  ) => void
  workspaceId?: string
}) {
  const query = useQuery(
    queryOptions({
      queryKey: ["mcp-connection", workspaceId, connection.scope, connection.name],
      queryFn: async () => {
        const result = await getMcpConnection({
          baseUrl: await getGatewayBaseURL(),
          headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
          path: { name: connection.name },
          query: { scope: connection.scope },
        })
        if (result.error) {
          throw new Error(result.error.message)
        }
        return result.data
      },
      retry: false,
      staleTime: 30_000,
    })
  )

  if (query.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        Loading tools...
      </div>
    )
  }

  if (query.isError) {
    return <div className="text-destructive text-sm">{query.error.message}</div>
  }

  const detail = query.data
  if (!detail.tool_catalog_ready) {
    return (
      <p className="text-muted-foreground text-sm">
        We have not finished loading the tool catalog. {detail.message}
      </p>
    )
  }
  if (detail.tools.length === 0) {
    return <p className="text-muted-foreground text-sm">This MCP connection exposes no tools.</p>
  }

  const toolsByName = new Map(selectedRef?.tools.map((tool) => [tool.name, tool]) ?? [])
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Choose which tools from <em>{connection.name}</em> this Sandbox may expose to Agents.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] overflow-hidden rounded border sm:mx-3">
        {detail.tools.map((tool) => {
          const selectedTool = toolsByName.get(tool.name)
          const selected = Boolean(selectedTool)
          const consentRequired = selectedTool?.requireConsent ?? false
          const consentLabel = consentRequired ? "Consent required" : "Consent not required"
          const consentActionLabel = consentRequired
            ? `Consent required for ${tool.name}. Activate to remove the requirement.`
            : `Consent not required for ${tool.name}. Activate to require consent.`

          const handleCheckedChange = (checked: boolean) => {
            if (checked) {
              onToolsChange(
                connection.scope,
                connection.name,
                [...toolsByName.values(), { name: tool.name, requireConsent: false }].toSorted(
                  (a, b) => a.name.localeCompare(b.name)
                )
              )
              return
            }

            onToolsChange(
              connection.scope,
              connection.name,
              [...toolsByName.values()].filter((value) => value.name !== tool.name)
            )
          }

          const handleConsentToggle = () => {
            if (!selectedTool) {
              return
            }

            onToolsChange(
              connection.scope,
              connection.name,
              [...toolsByName.values()]
                .map((value) =>
                  value.name === tool.name
                    ? {
                        name: value.name,
                        requireConsent: !value.requireConsent,
                      }
                    : value
                )
                .toSorted((a, b) => a.name.localeCompare(b.name))
            )
          }

          return (
            <label
              key={tool.name}
              className="-mr-px -mb-px grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border px-4 py-3"
            >
              <span className="min-w-0">
                <span className="block leading-5 font-medium break-all whitespace-normal">
                  {tool.name}
                </span>
              </span>

              <div className="flex items-center justify-end gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={!selectedTool}
                      onClick={handleConsentToggle}
                      aria-label={consentActionLabel}
                      className={
                        consentRequired
                          ? "text-primary hover:text-primary"
                          : "text-muted-foreground"
                      }
                    >
                      <UserCheck className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{consentLabel}</TooltipContent>
                </Tooltip>
                <Switch
                  checked={selected}
                  onCheckedChange={handleCheckedChange}
                  aria-label={`Enable ${tool.name}`}
                  className="shrink-0"
                />
              </div>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function McpStep({
  initialMcpConnectionRefs,
  initialNextPageToken,
  mcpConnections,
  workspaceId,
  onAdvanceAction,
  onNext,
  onPrev,
}: McpStepProps) {
  const searchParams = useSearchParams()
  const requestedSortBy = z.enum(["name", "created_at"]).safeParse(searchParams.get("mcp_sort_by"))
  const requestedSortOrder = z.enum(["asc", "desc"]).safeParse(searchParams.get("mcp_sort_order"))
  const sortBy: ResourceSortByQuery = requestedSortBy.success ? requestedSortBy.data : "created_at"
  const sortOrder = requestedSortOrder.success ? requestedSortOrder.data : "desc"
  const sorting: SortingState = [
    { id: sortBy === "created_at" ? "age" : "name", desc: sortOrder === "desc" },
  ]
  const { onSortingChange } = useServerSorting({
    fields: { age: "created_at", name: "name" } satisfies Record<string, ResourceSortByQuery>,
    sortByKey: "mcp_sort_by",
    sortOrderKey: "mcp_sort_order",
    sorting,
  })
  const form = useForm<McpStepValues>({
    resolver: zodResolver(mcpStepSchema),
    defaultValues: {
      mcpConnectionRefs: initialMcpConnectionRefs,
    },
  })
  const selected = useWatch({
    control: form.control,
    name: "mcpConnectionRefs",
    defaultValue: initialMcpConnectionRefs,
  })
  const selectedByReference = React.useMemo(
    () => new Map(selected.map((ref) => [JSON.stringify([ref.scope, ref.name]), ref])),
    [selected]
  )
  const selectedReferences = React.useMemo(
    () => new Set(selectedByReference.keys()),
    [selectedByReference]
  )
  const [expandedReferences, setExpandedReferences] = React.useState<string[]>([])
  const expandedReferenceSet = React.useMemo(
    () => new Set(expandedReferences),
    [expandedReferences]
  )
  const toggleExpandedReference = React.useCallback((reference: string) => {
    setExpandedReferences((current) =>
      current.includes(reference)
        ? current.filter((value) => value !== reference)
        : [...current, reference]
    )
  }, [])

  const setSelected = React.useCallback(
    async (connection: McpConnectionSummary, checked: boolean) => {
      const current = form.getValues("mcpConnectionRefs") ?? []
      const next = new Map(
        current.map((ref) => [JSON.stringify([ref.scope, ref.name]), ref] as const)
      )
      const reference = JSON.stringify([connection.scope, connection.name])

      if (!checked) {
        next.delete(reference)
      } else {
        const existing = next.get(reference)
        if (existing) {
          next.set(reference, {
            scope: existing.scope,
            name: existing.name,
            tools: existing.tools.toSorted((a, b) => a.name.localeCompare(b.name)),
          })
        } else {
          const result = await getMcpConnection({
            baseUrl: await getGatewayBaseURL(),
            headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
            path: { name: connection.name },
            query: { scope: connection.scope },
          })
          if (result.error || !result.data.tool_catalog_ready) {
            return
          }
          next.set(reference, {
            scope: connection.scope,
            name: connection.name,
            tools: result.data.tools
              .map((tool) => ({
                name: tool.name,
                requireConsent: false,
              }))
              .toSorted((a, b) => a.name.localeCompare(b.name)),
          })
        }
      }

      const nextRefs = [...next.values()].toSorted(
        (a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)
      )

      form.setValue("mcpConnectionRefs", nextRefs, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [form, workspaceId]
  )
  const setEnabledTools = React.useCallback(
    (scope: McpConnectionSummary["scope"], name: string, tools: SelectedMcpTool[]) => {
      const current = form.getValues("mcpConnectionRefs") ?? []
      const next = current
        .map((ref) => {
          if (ref.scope !== scope || ref.name !== name) {
            return ref
          }
          return {
            scope,
            name,
            tools,
          }
        })
        .filter((ref) => ref.tools.length > 0)

      form.setValue("mcpConnectionRefs", next, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [form]
  )

  const loadPage = React.useCallback(
    async (pageToken?: string): Promise<CursorPage<McpConnectionSummary>> => {
      const result = await listMcpConnections({
        baseUrl: await getGatewayBaseURL(),
        headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
        query: {
          limit: 50,
          page_token: pageToken,
          sort_by: sortBy,
          sort_order: sortOrder,
        },
      })
      if (result.error) throw new globalThis.Error(result.error.message)
      return {
        rows: result.data.mcp_connections,
        nextPageToken: result.data.next_page_token,
      }
    },
    [sortBy, sortOrder, workspaceId]
  )
  const page = useCursorPage(
    mcpConnections,
    initialNextPageToken,
    loadPage,
    `${sortBy}:${sortOrder}`,
    "created_at:desc"
  )

  const columns = React.useMemo(
    () =>
      createMcpSelectionColumns({
        expandedReferences: expandedReferenceSet,
        selectedReferences,
        onExpandedChange: toggleExpandedReference,
        onSelectedChange: (connection, checked) => {
          void setSelected(connection, checked)
        },
      }),
    [expandedReferenceSet, selectedReferences, setSelected, toggleExpandedReference]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: page.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    onSortingChange,
    state: { sorting },
  })

  return (
    <form
      id={formIdByStep.mcps}
      onSubmit={form.handleSubmit((data) =>
        onNext(data.mcpConnectionRefs.toSorted((a, b) => a.name.localeCompare(b.name)))
      )}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
    >
      <div className="-mx-4 w-[calc(100%+2rem)] min-w-0 space-y-4 sm:-mx-6 sm:w-[calc(100%+3rem)]">
        <AdminDataGrid
          ariaLabel="MCP connections"
          emptyState={
            <p className="text-muted-foreground py-8 text-center">No MCP connections found.</p>
          }
          layout={mcpLayout}
          pagination={
            <div className="space-y-2">
              {page.error ? (
                <p className="text-destructive text-center text-sm" role="alert">
                  {page.error.message}
                </p>
              ) : null}
              <TablePagination
                canGoNext={page.canGoNext}
                canGoPrevious={page.canGoPrevious}
                goNext={page.goNext}
                goPrevious={page.goPrevious}
                pending={page.pending}
              />
            </div>
          }
          renderSubRow={(connection) => {
            const reference = JSON.stringify([connection.scope, connection.name])
            return expandedReferenceSet.has(reference) ? (
              <McpToolsPanel
                connection={connection}
                selectedRef={selectedByReference.get(reference)}
                onToolsChange={setEnabledTools}
                workspaceId={workspaceId}
              />
            ) : null
          }}
          rows={page.rows}
          table={table}
        />
      </div>
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          type="submit"
          onClick={onAdvanceAction}
          disabled={form.formState.isSubmitting || selected.some((ref) => ref.tools.length === 0)}
        >
          Next
          {form.formState.isSubmitting ? (
            <Spinner data-icon="inline-end" />
          ) : (
            <ArrowRight data-icon="inline-end" />
          )}
        </Button>
      </StepActions>
    </form>
  )
}

function SkillsStep({
  immutableSkills,
  initialNextPageToken,
  initialSkills,
  workspaceId,
  onAdvanceAction,
  onNext,
  onPrev,
}: SkillsStepProps) {
  const searchParams = useSearchParams()
  const requestedSortBy = z.enum(["name", "version"]).safeParse(searchParams.get("skill_sort_by"))
  const requestedSortOrder = z.enum(["asc", "desc"]).safeParse(searchParams.get("skill_sort_order"))
  const sortBy: ImmutableSkillSortByQuery = requestedSortBy.success ? requestedSortBy.data : "name"
  const sortOrder = requestedSortOrder.success ? requestedSortOrder.data : "asc"
  const sorting: SortingState = [{ id: sortBy, desc: sortOrder === "desc" }]
  const { onSortingChange } = useServerSorting({
    fields: { name: "name", version: "version" } satisfies Record<
      string,
      ImmutableSkillSortByQuery
    >,
    sortByKey: "skill_sort_by",
    sortOrderKey: "skill_sort_order",
    sorting,
  })
  const form = useForm<SkillsStepValues>({
    resolver: zodResolver(skillsStepSchema),
    defaultValues: {
      skills: initialSkills,
    },
  })
  const selected = useWatch({
    control: form.control,
    name: "skills",
    defaultValue: initialSkills,
  })
  const selectedReferences = React.useMemo(
    () => new Set(selected.map((ref) => JSON.stringify([ref.scope, ref.name]))),
    [selected]
  )

  const setSelected = React.useCallback(
    (skill: Skill, checked: boolean) => {
      const current = form.getValues("skills") ?? []
      const next = checked
        ? [...current, { scope: skill.scope, name: skill.name }].toSorted(
            (a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)
          )
        : current.filter((ref) => ref.scope !== skill.scope || ref.name !== skill.name)

      form.setValue("skills", next, {
        shouldDirty: true,
        shouldValidate: true,
      })
    },
    [form]
  )

  const loadPage = React.useCallback(
    async (pageToken?: string): Promise<CursorPage<Skill>> => {
      const result = await listSkills({
        baseUrl: await getGatewayBaseURL(),
        headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
        query: {
          limit: 50,
          page_token: pageToken,
          sort_by: sortBy,
          sort_order: sortOrder,
        },
      })
      if (result.error) throw new globalThis.Error(result.error.message)
      return {
        rows: result.data.skills,
        nextPageToken: result.data.next_page_token,
      }
    },
    [sortBy, sortOrder, workspaceId]
  )
  const page = useCursorPage(
    immutableSkills,
    initialNextPageToken,
    loadPage,
    `${sortBy}:${sortOrder}`,
    "name:asc"
  )

  const columns = React.useMemo(
    () =>
      createSkillSelectionColumns({
        selectedReferences,
        onSelectedChange: setSelected,
      }),
    [selectedReferences, setSelected]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: page.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    onSortingChange,
    state: { sorting },
  })

  return (
    <form
      id={formIdByStep.skills}
      onSubmit={form.handleSubmit((data) => onNext(data.skills.toSorted()))}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
    >
      <div className="-mx-4 w-[calc(100%+2rem)] min-w-0 space-y-4 sm:-mx-6 sm:w-[calc(100%+3rem)]">
        <AdminDataGrid
          ariaLabel="Skills"
          emptyState={<p className="text-muted-foreground py-8 text-center">No skills found.</p>}
          layout={skillLayout}
          pagination={
            <div className="space-y-2">
              {page.error ? (
                <p className="text-destructive text-center text-sm" role="alert">
                  {page.error.message}
                </p>
              ) : null}
              <TablePagination
                canGoNext={page.canGoNext}
                canGoPrevious={page.canGoPrevious}
                goNext={page.goNext}
                goPrevious={page.goPrevious}
                pending={page.pending}
              />
            </div>
          }
          rows={page.rows}
          table={table}
        />
      </div>
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button type="submit" onClick={onAdvanceAction} disabled={form.formState.isSubmitting}>
          Next
          {form.formState.isSubmitting ? (
            <Spinner data-icon="inline-end" />
          ) : (
            <ArrowRight data-icon="inline-end" />
          )}
        </Button>
      </StepActions>
    </form>
  )
}

function ModelsStep({
  inferenceProviders,
  inferencePools,
  inference,
  providersHref,
  scope,
  onAdvanceAction,
  onChangeAction,
  onNext,
  onPrev,
}: ModelsStepProps) {
  const [providers, setProviders] = React.useState(inferenceProviders)
  const [pools, setPools] = React.useState(inferencePools)
  const [refreshError, setRefreshError] = React.useState("")
  const [refreshing, startRefresh] = React.useTransition()
  const [invalidSubmit, setInvalidSubmit] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const selected = inference?.models ?? []

  const refs = new Map(
    selected.map((ref) => [JSON.stringify([ref.scope, ref.provider, ref.model]), ref] as const)
  )
  const providersByReference = React.useMemo(
    () =>
      new Map(
        providers.map((provider) => [JSON.stringify([provider.scope, provider.id]), provider])
      ),
    [providers]
  )
  const poolsById = React.useMemo(() => new Map(pools.map((pool) => [pool.id, pool])), [pools])
  const selectedCountByProvider = new Map<string, number>()
  for (const ref of selected) {
    const provider = JSON.stringify([ref.scope, ref.provider])
    selectedCountByProvider.set(provider, (selectedCountByProvider.get(provider) ?? 0) + 1)
  }

  const defaultRefKey = inference
    ? JSON.stringify([
        inference.default_model.scope,
        inference.default_model.provider,
        inference.default_model.model,
      ])
    : undefined
  const smallKey = inference?.small_model
    ? JSON.stringify([
        inference.small_model.scope,
        inference.small_model.provider,
        inference.small_model.model,
      ])
    : undefined
  const attachmentKey = inference?.attachment_model
    ? JSON.stringify([
        inference.attachment_model.scope,
        inference.attachment_model.provider,
        inference.attachment_model.model,
      ])
    : undefined
  // Accordion reads defaultValue only at mount: open providers that hold a
  // selection (edit mode), or the first provider when starting empty.
  const initiallyOpenProviders = providers.some((provider) =>
    selectedCountByProvider.has(JSON.stringify([provider.scope, provider.id]))
  )
    ? providers
        .filter((provider) =>
          selectedCountByProvider.has(JSON.stringify([provider.scope, provider.id]))
        )
        .map((provider) => JSON.stringify([provider.scope, provider.id]))
    : providers.slice(0, 1).map((provider) => JSON.stringify([provider.scope, provider.id]))

  function toggleModel(ref: SandboxInferenceModelRef, checked: boolean) {
    const key = JSON.stringify([ref.scope, ref.provider, ref.model])
    if (checked) {
      onChangeAction(
        inference
          ? { ...inference, models: [...selected, ref] }
          : { models: [ref], default_model: ref }
      )
      setInvalidSubmit(false)
      return
    }

    if (!inference) {
      return
    }

    const models = selected.filter(
      (item) => JSON.stringify([item.scope, item.provider, item.model]) !== key
    )
    const [first] = models
    if (!first) {
      onChangeAction(undefined)
      return
    }

    onChangeAction({
      ...inference,
      models,
      default_model: defaultRefKey === key ? first : inference.default_model,
      small_model: smallKey === key ? undefined : inference.small_model,
      attachment_model: attachmentKey === key ? undefined : inference.attachment_model,
    })
  }

  function setOptionalModel(field: "small_model" | "attachment_model", value: string) {
    if (!inference) {
      return
    }
    if (value === "none") {
      onChangeAction({ ...inference, [field]: undefined })
      return
    }
    const model = refs.get(value)
    if (model) {
      onChangeAction({ ...inference, [field]: model })
    }
  }

  // One options feed both selects; display names fall back to raw IDs when a
  // provider or model no longer exists in the catalog (e.g. stale edit draft).
  const modelOptions = selected.map((ref) => {
    const key = JSON.stringify([ref.scope, ref.provider, ref.model])
    const provider = providersByReference.get(JSON.stringify([ref.scope, ref.provider]))
    const model = provider?.models.find((item) => item.id === ref.model)
    const pool = ref.provider === "agentz-pools" ? poolsById.get(ref.model) : undefined
    return (
      <SelectItem key={key} value={key}>
        {pool ? <Layers3 /> : <Brain />}
        <span className="truncate">{pool?.display_name ?? model?.display_name ?? ref.model}</span>
        <span className="text-muted-foreground truncate">
          {pool ? "Inference Pool" : (provider?.display_name ?? ref.provider)}
        </span>
      </SelectItem>
    )
  })
  const attachmentModelOptions = selected.flatMap((ref) => {
    const provider = providersByReference.get(JSON.stringify([ref.scope, ref.provider]))
    const model = provider?.models.find((item) => item.id === ref.model)
    const pool = ref.provider === "agentz-pools" ? poolsById.get(ref.model) : undefined
    const contract = pool?.contract ?? model
    if (!contract?.capabilities.attachment || !contract.modalities.input.includes("image")) {
      return []
    }

    const key = JSON.stringify([ref.scope, ref.provider, ref.model])
    return [
      <SelectItem key={key} value={key}>
        {pool ? <Layers3 /> : <Brain />}
        <span className="truncate">{pool?.display_name ?? model?.display_name ?? ref.model}</span>
        <span className="text-muted-foreground truncate">
          {pool ? "Inference Pool" : (provider?.display_name ?? ref.provider)}
        </span>
      </SelectItem>,
    ]
  })

  return (
    <form
      id={formIdByStep.models}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!inference) {
          setInvalidSubmit(true)
          return
        }
        setSubmitting(true)
        onNext()
      }}
    >
      {providers.length === 0 && pools.length === 0 ? (
        <Empty className="gap-3 p-8">
          <EmptyHeader>
            <EmptyMedia>
              <Brain className="text-muted-foreground size-8" aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No inference providers are configured</EmptyTitle>
            <EmptyDescription>
              Add a provider in a new tab, then refresh this catalog. Your draft will stay here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href={providersHref} target="_blank" rel="noreferrer">
                  Open provider setup
                  <ExternalLink data-icon="inline-end" />
                </Link>
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={refreshing}
                onClick={() =>
                  startRefresh(async () => {
                    const providerResult = await refreshInferenceProvidersAction(scope)
                    const poolResult = scope.workspaceId
                      ? await refreshInferencePoolsAction({
                          basePath: scope.basePath,
                          workspaceId: scope.workspaceId,
                        })
                      : { pools: [], error: undefined }
                    if (providerResult.error || poolResult.error) {
                      setRefreshError(
                        providerResult.error?.message ??
                          poolResult.error?.message ??
                          "Inference catalog could not be refreshed"
                      )
                      return
                    }
                    setRefreshError("")
                    setProviders(providerResult.providers)
                    setPools(poolResult.pools)
                  })
                }
              >
                {refreshing ? <Spinner /> : <RefreshCw />} Refresh
              </Button>
            </div>
            {refreshError ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{refreshError}</AlertDescription>
              </Alert>
            ) : null}
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid min-h-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="order-2 min-w-0 lg:order-1">
            {pools.length > 0 ? (
              <section className="mb-5 overflow-hidden rounded-lg border">
                <div className="bg-muted/30 border-b px-3 py-2.5">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    <Layers3 className="size-4" />
                    Pools
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    A Pool routes one model name through an ordered list of models.
                  </p>
                </div>
                <div className="divide-y">
                  {pools.map((pool) => {
                    const ref: SandboxInferenceModelRef = {
                      scope: "Workspace",
                      provider: "agentz-pools",
                      model: pool.id,
                    }
                    const active = refs.has(JSON.stringify([ref.scope, ref.provider, ref.model]))
                    const available = pool.state === "Ready" || pool.state === "PartiallyDegraded"
                    const failures = pool.member_statuses.filter((member) => !member.ready)
                    return (
                      <label
                        key={pool.id}
                        className={`flex items-start gap-3 px-3 py-3 transition-colors ${available || active ? "hover:bg-muted/50 cursor-pointer" : "cursor-not-allowed opacity-65"} ${active ? "bg-primary/5" : ""}`}
                      >
                        <Layers3 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {pool.display_name}
                            </span>
                            <Badge
                              variant={
                                pool.state === "Ready"
                                  ? "success"
                                  : pool.state === "PartiallyDegraded"
                                    ? "warning"
                                    : pool.state === "Degraded"
                                      ? "destructive"
                                      : "pending"
                              }
                            >
                              {pool.state === "PartiallyDegraded" ? "Partial" : pool.state}
                            </Badge>
                          </div>
                          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                            <span>
                              {pool.members.length} {pool.members.length === 1 ? "model" : "models"}
                            </span>
                            {pool.protocol ? (
                              <>
                                <span aria-hidden>·</span>
                                <span className="flex items-center gap-1">
                                  <ProviderIcon
                                    provider={
                                      pool.protocol === "Anthropic" ? "anthropic" : "openai"
                                    }
                                    className="size-3.5"
                                  />
                                  {pool.protocol} primary
                                </span>
                              </>
                            ) : null}
                            {pool.contract ? (
                              <>
                                <span aria-hidden>·</span>
                                <span>
                                  {formatCompactNumber(pool.contract.limits.context)} context
                                </span>
                              </>
                            ) : null}
                          </div>
                          {pool.state === "PartiallyDegraded" || pool.warnings.length ? (
                            <Alert variant="warning" className="mt-2">
                              <TriangleAlert />
                              <AlertDescription>
                                {failures.length
                                  ? `${failures.map((member) => `${member.provider}/${member.model}`).join(", ")} unavailable. `
                                  : ""}
                                {pool.warnings.length
                                  ? "Requests that use provider-specific fields may fail when this Pool switches models."
                                  : ""}
                              </AlertDescription>
                            </Alert>
                          ) : null}
                        </div>
                        <Switch
                          checked={active}
                          disabled={!available && !active}
                          onCheckedChange={(checked) => toggleModel(ref, checked)}
                          aria-label={`${active ? "Remove" : "Add"} ${pool.display_name}`}
                        />
                      </label>
                    )
                  })}
                </div>
              </section>
            ) : null}
            <Accordion
              type="multiple"
              defaultValue={initiallyOpenProviders}
              className="overflow-hidden rounded-lg border"
            >
              {providers.map((provider) => {
                const providerReference = JSON.stringify([provider.scope, provider.id])
                const selectedCount = selectedCountByProvider.get(providerReference) ?? 0
                return (
                  <AccordionItem key={providerReference} value={providerReference}>
                    <AccordionTrigger className="hover:bg-muted/50 px-3 hover:no-underline **:data-[slot=accordion-trigger-icon]:ml-0!">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <ProviderIcon
                          provider={provider.catalog_provider}
                          className="size-4 shrink-0"
                        />
                        <span className="truncate font-medium">{provider.display_name}</span>
                        <Badge variant="outline">{provider.scope}</Badge>
                        <span className="text-muted-foreground hidden truncate text-xs md:inline">
                          {providerKindLabels[provider.kind]}
                        </span>
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        {selectedCount > 0 ? (
                          <Badge variant="secondary">{selectedCount} selected</Badge>
                        ) : null}
                        {provider.state !== "Ready" ? (
                          <Badge
                            variant={provider.state === "Degraded" ? "destructive" : "pending"}
                          >
                            {provider.state}
                          </Badge>
                        ) : null}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="p-0">
                      {provider.models.length === 0 ? (
                        <p className="text-muted-foreground border-t px-3 py-4 text-sm">
                          This provider has no models.
                        </p>
                      ) : (
                        <div className="divide-y border-t">
                          {provider.models.map((model) => {
                            const ref: SandboxInferenceModelRef = {
                              scope: provider.scope,
                              provider: provider.id,
                              model: model.id,
                            }
                            const active = refs.has(
                              JSON.stringify([ref.scope, ref.provider, ref.model])
                            )
                            return (
                              <label
                                key={JSON.stringify([provider.scope, provider.id, model.id])}
                                className={`hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors ${active ? "bg-primary/5" : ""}`}
                              >
                                <div className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium">
                                    {model.display_name}
                                  </span>
                                  <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                                    <span className="truncate font-mono">{model.id}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="shrink-0 tabular-nums">
                                      {formatCompactNumber(model.limits.context)} context
                                    </span>
                                  </div>
                                </div>
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                  {model.capabilities.tool_call ? (
                                    <Badge variant="outline">Tools</Badge>
                                  ) : null}
                                  {model.capabilities.reasoning ? (
                                    <Badge variant="outline">Reasoning</Badge>
                                  ) : null}
                                </div>
                                <Switch
                                  checked={active}
                                  onCheckedChange={(checked) => toggleModel(ref, checked)}
                                  aria-label={`${active ? "Remove" : "Add"} ${model.display_name}`}
                                />
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          </div>
          <aside className="order-1 min-w-0 lg:sticky lg:top-0 lg:order-2 lg:self-start">
            <div className="overflow-hidden rounded-lg border">
              <div className="bg-muted/30 flex items-center justify-between border-b px-4 py-2.5">
                <h2 className="text-sm font-medium">Selected models</h2>
                <Badge variant="secondary">{selected.length}</Badge>
              </div>
              <div className="space-y-4 p-4">
                {selected.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
                    Expand a provider to start adding models.
                  </p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {selected.map((ref) => {
                      const key = JSON.stringify([ref.scope, ref.provider, ref.model])
                      const provider = providersByReference.get(
                        JSON.stringify([ref.scope, ref.provider])
                      )
                      const model = provider?.models.find((item) => item.id === ref.model)
                      const pool =
                        ref.provider === "agentz-pools" ? poolsById.get(ref.model) : undefined
                      const displayName = pool?.display_name ?? model?.display_name ?? ref.model
                      return (
                        <li key={key} className="flex items-center gap-2.5 px-3 py-2">
                          {pool ? (
                            <Layers3 className="text-muted-foreground size-4 shrink-0" />
                          ) : provider ? (
                            <ProviderIcon
                              provider={provider.catalog_provider}
                              className="size-4 shrink-0"
                            />
                          ) : (
                            <Brain className="text-muted-foreground size-4 shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{displayName}</div>
                            <div className="text-muted-foreground truncate text-xs">
                              {pool ? "Inference Pool" : (provider?.display_name ?? ref.provider)}
                            </div>
                          </div>
                          {key === defaultRefKey ? <Badge variant="outline">Default</Badge> : null}
                          {key === smallKey ? <Badge variant="outline">Small</Badge> : null}
                          {key === attachmentKey ? (
                            <Badge variant="outline">Attachments</Badge>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${displayName}`}
                            onClick={() => toggleModel(ref, false)}
                          >
                            <X />
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <Field>
                  <FieldLabel required>Default model</FieldLabel>
                  <Select
                    value={defaultRefKey ?? ""}
                    onValueChange={(value) => {
                      const model = refs.get(value)
                      if (!inference || !model) {
                        return
                      }
                      onChangeAction({ ...inference, default_model: model })
                    }}
                    disabled={selected.length === 0}
                  >
                    <SelectTrigger className="w-full" aria-label="Default model">
                      <SelectValue placeholder="Choose a default model" />
                    </SelectTrigger>
                    <SelectContent>{modelOptions}</SelectContent>
                  </Select>
                  <FieldDescription>
                    We use this model for new sessions and Workflow runs.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Attachment model</FieldLabel>
                  <Select
                    value={attachmentKey ?? "none"}
                    onValueChange={(value) => setOptionalModel("attachment_model", value)}
                    disabled={attachmentModelOptions.length === 0}
                  >
                    <SelectTrigger className="w-full" aria-label="Attachment model">
                      <SelectValue placeholder="Use capable default model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        <Brain /> Use capable default model
                      </SelectItem>
                      {attachmentModelOptions}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Optional model that processes images and scanned PDF pages.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Small model</FieldLabel>
                  <Select
                    value={smallKey ?? "none"}
                    onValueChange={(value) => setOptionalModel("small_model", value)}
                    disabled={selected.length === 0}
                  >
                    <SelectTrigger className="w-full" aria-label="Small model">
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        <Brain /> Not set
                      </SelectItem>
                      {modelOptions}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Optional lower-cost model for lightweight background tasks.
                  </FieldDescription>
                </Field>
                {invalidSubmit && !inference ? (
                  <FieldError errors={[{ message: "Select at least one model to continue." }]} />
                ) : null}
              </div>
            </div>
          </aside>
        </div>
      )}
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          type="submit"
          onClick={onAdvanceAction}
          disabled={submitting || (providers.length === 0 && pools.length === 0)}
        >
          Next
          {submitting ? <Spinner data-icon="inline-end" /> : <ArrowRight data-icon="inline-end" />}
        </Button>
      </StepActions>
    </form>
  )
}

function AllowedHostsStep({
  identity,
  initialAllowedHosts,
  initialDraft,
  mcpConnectionRefs,
  packages,
  skills,
  inference,
  mode,
  scope,
  secretHostSuggestions,
  onAllowedHostsChangeAction,
  onPrev,
}: AllowedHostsStepProps) {
  const router = useRouter()
  const [draft, setDraft] = React.useState(initialDraft)
  const [draftError, setDraftError] = React.useState<string>()
  const [state, action, pending] = useActionState<CreateSandboxFormState, FormData>(
    async (state, formData) => {
      const result =
        mode === "update"
          ? await updateSandboxFormAction(scope, identity.name, state, formData)
          : await createSandboxFormAction(scope, state, formData)
      if (result.success) {
        toast.success(mode === "update" ? "Sandbox updated" : "Sandbox created")
        router.push(scope.basePath as Route)
      }
      return result
    },
    {}
  )
  const form = useForm<AllowedHostsStepValues>({
    resolver: zodResolver(allowedHostsStepSchema),
    defaultValues: {
      allowedHosts: initialAllowedHosts,
    },
  })
  const submitLabel = mode === "update" ? "Update sandbox" : "Create sandbox"
  const pendingLabel = mode === "update" ? "Updating…" : "Creating…"
  const hosts = useWatch({
    control: form.control,
    name: "allowedHosts",
    defaultValue: initialAllowedHosts,
  })
  const allowedHostsError = form.formState.errors.allowedHosts
  const hostFieldInvalid = Boolean(allowedHostsError) || Boolean(draftError)
  const generalError =
    state.error && !state.error.errors?.some((error) => error.field === "allowedHosts")
      ? state.error
      : undefined

  React.useEffect(() => {
    if (!state.error?.errors) {
      return
    }

    for (const error of state.error.errors) {
      if (error.field === "allowedHosts") {
        form.setError("allowedHosts", {
          type: "server",
          message: error.message,
        })
      }
    }
  }, [form, state.error])

  function setAllowedHostsState(nextHosts: string[], nextDraft: string) {
    form.setValue("allowedHosts", nextHosts, {
      shouldDirty: true,
      shouldValidate: true,
    })
    onAllowedHostsChangeAction({
      allowedHosts: nextHosts,
      draft: nextDraft,
    })
  }

  function addHost() {
    const parsed = sandboxAllowedHostSchema.safeParse(draft)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? "Host is invalid")
      return
    }

    const nextHosts = Array.from(new Set([...hosts, parsed.data])).sort()
    setAllowedHostsState(nextHosts, "")
    setDraft("")
    setDraftError(undefined)
    form.clearErrors("allowedHosts")
  }

  function addSuggestedHost(host: SecretHost) {
    const nextHosts = Array.from(new Set([...hosts, host])).sort()
    setAllowedHostsState(nextHosts, draft)
    setDraftError(undefined)
    form.clearErrors("allowedHosts")
  }

  async function submitAction(formData: FormData) {
    const isValid = await form.trigger()
    if (!isValid) {
      return
    }

    if (draft.trim() !== "") {
      setDraftError("Add or clear the host before submitting")
      return
    }

    startTransition(() => {
      action(formData)
    })
  }

  return (
    <form
      id={formIdByStep.allowedHosts}
      action={submitAction}
      className="flex min-h-full w-full min-w-0 flex-col gap-5"
    >
      <input type="hidden" name="name" value={identity.name} />
      {packages.map((pkg) => (
        <input key={pkg} type="hidden" name="packages" value={pkg} />
      ))}
      {skills.map((skill) => (
        <React.Fragment key={JSON.stringify([skill.scope, skill.name])}>
          <input type="hidden" name="skillScopes" value={skill.scope} />
          <input type="hidden" name="skillNames" value={skill.name} />
        </React.Fragment>
      ))}
      {inference.models.map((ref) => (
        <React.Fragment key={JSON.stringify([ref.scope, ref.provider, ref.model])}>
          <input type="hidden" name="inferenceModelScopes" value={ref.scope} />
          <input type="hidden" name="inferenceModelProviders" value={ref.provider} />
          <input type="hidden" name="inferenceModelIDs" value={ref.model} />
        </React.Fragment>
      ))}
      <input type="hidden" name="inferenceDefaultScope" value={inference.default_model.scope} />
      <input
        type="hidden"
        name="inferenceDefaultProvider"
        value={inference.default_model.provider}
      />
      <input type="hidden" name="inferenceDefaultModel" value={inference.default_model.model} />
      {inference.small_model && (
        <>
          <input type="hidden" name="inferenceSmallScope" value={inference.small_model.scope} />
          <input
            type="hidden"
            name="inferenceSmallProvider"
            value={inference.small_model.provider}
          />
          <input type="hidden" name="inferenceSmallModel" value={inference.small_model.model} />
        </>
      )}
      {inference.attachment_model && (
        <>
          <input
            type="hidden"
            name="inferenceAttachmentScope"
            value={inference.attachment_model.scope}
          />
          <input
            type="hidden"
            name="inferenceAttachmentProvider"
            value={inference.attachment_model.provider}
          />
          <input
            type="hidden"
            name="inferenceAttachmentModel"
            value={inference.attachment_model.model}
          />
        </>
      )}
      {mcpConnectionRefs.map((ref) => (
        <React.Fragment key={JSON.stringify([ref.scope, ref.name])}>
          <input type="hidden" name="mcpConnectionScopes" value={ref.scope} />
          <input type="hidden" name="mcpConnectionNames" value={ref.name} />
          {ref.tools.map((tool) => (
            <React.Fragment key={JSON.stringify([ref.scope, ref.name, tool.name])}>
              <input type="hidden" name="mcpToolScopes" value={ref.scope} />
              <input type="hidden" name="mcpToolConnections" value={ref.name} />
              <input type="hidden" name="mcpToolNames" value={tool.name} />
              {tool.requireConsent ? (
                <>
                  <input type="hidden" name="mcpConsentScopes" value={ref.scope} />
                  <input type="hidden" name="mcpConsentConnections" value={ref.name} />
                  <input type="hidden" name="mcpConsentToolNames" value={tool.name} />
                </>
              ) : null}
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
      {hosts.map((host) => (
        <input key={host} type="hidden" name="allowedHosts" value={host} />
      ))}
      <FieldSet>
        <FieldLegend>Allowed hosts</FieldLegend>
        <FieldDescription>
          Add an exact domain or IP address, or an IPv4 or IPv6 CIDR range. `*.` matches one
          subdomain label; `**.` matches any depth.
        </FieldDescription>
        <FieldGroup>
          <Field data-invalid={hostFieldInvalid}>
            <FieldLabel htmlFor="sandbox-form-allowed-host">Host</FieldLabel>
            <InputGroup className="h-9">
              <InputGroupInput
                id="sandbox-form-allowed-host"
                value={draft}
                onChange={(event) => {
                  const nextDraft = event.target.value
                  setDraft(nextDraft)
                  setDraftError(undefined)
                  onAllowedHostsChangeAction({
                    allowedHosts: hosts,
                    draft: nextDraft,
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addHost()
                }}
                autoFocus
                placeholder="api.github.com"
                autoComplete="off"
                aria-invalid={hostFieldInvalid}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={addHost} aria-label="Add allowed host">
                  <Plus />
                  Add
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {secretHostSuggestions ? (
              <React.Suspense fallback={<AllowedHostSuggestionsLoading />}>
                <AllowedHostSuggestions
                  hosts={hosts}
                  secretHostSuggestions={secretHostSuggestions}
                  onSuggestionAction={addSuggestedHost}
                />
              </React.Suspense>
            ) : null}
          </Field>
          {hosts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {hosts.map((host) => (
                <Button
                  key={host}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-w-full"
                  onClick={() =>
                    setAllowedHostsState(
                      hosts.filter((item) => item !== host),
                      draft
                    )
                  }
                >
                  <span className="min-w-0 truncate">{host}</span>
                  <X data-icon="inline-end" />
                </Button>
              ))}
            </div>
          ) : null}
          {draftError ? <FieldError errors={[{ message: draftError }]} /> : null}
          {allowedHostsError ? <FieldError errors={[allowedHostsError]} /> : null}
        </FieldGroup>
      </FieldSet>
      {generalError ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 text-destructive rounded border p-3 text-sm"
        >
          <p className="font-medium">{generalError.message}</p>
          {generalError.errors && generalError.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {generalError.errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  {error.field}: {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <StepActions>
        <Button type="button" variant="secondary" onClick={onPrev} disabled={pending}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : <Box data-icon="inline-start" />}
          {pending ? pendingLabel : submitLabel}
        </Button>
      </StepActions>
    </form>
  )
}

function AllowedHostSuggestionsLoading() {
  return (
    <div className="text-muted-foreground flex items-center gap-2 pt-1 text-sm" aria-live="polite">
      <Spinner />
      <span>Loading host suggestions...</span>
    </div>
  )
}

function AllowedHostSuggestions({
  hosts,
  secretHostSuggestions,
  onSuggestionAction,
}: {
  hosts: string[]
  secretHostSuggestions: Promise<SecretHost[]>
  onSuggestionAction: (host: SecretHost) => void
}) {
  const allowed = new Set(hosts)
  const suggestions = React.use(secretHostSuggestions).filter((host) => !allowed.has(host))

  if (suggestions.length === 0) {
    return null
  }

  return (
    <div
      className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 pt-1"
      aria-label="Secret host suggestions"
    >
      {suggestions.map((host) => (
        <button
          key={host}
          type="button"
          className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 max-w-full rounded-sm text-left text-sm underline underline-offset-4 transition-[color,box-shadow] outline-none focus-visible:ring-3"
          onClick={() => onSuggestionAction(host)}
        >
          <span className="block truncate">{host}</span>
        </button>
      ))}
    </div>
  )
}

function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex flex-wrap justify-end gap-3 pt-4 pb-2">{children}</div>
}

export function SandboxWizard({
  initialAllowedHosts = [],
  initialMcpConnectionRefs = [],
  initialName = "",
  initialPackages = [],
  initialSkills = [],
  initialInference,
  immutableSkills,
  immutableSkillsNextPageToken,
  inferenceProviders,
  inferencePools,
  mcpConnections,
  mcpConnectionsNextPageToken,
  mode,
  providersHref,
  scope,
  secretHostSuggestions,
}: SandboxWizardProps) {
  const [direction, setDirection] = useState(1)
  const pendingNavigationRef = useRef<NavigationRequest | undefined>(undefined)
  const initialIdentity = { name: initialName }

  return (
    <Stepper.Root
      className="flex min-h-0 w-full flex-1"
      initialMetadata={{
        identity: initialName ? initialIdentity : undefined,
        packages: initialPackages,
        mcps: initialMcpConnectionRefs,
        skills: initialSkills,
        models: initialInference ?? null,
        allowedHosts: {
          allowedHosts: initialAllowedHosts,
          draft: "",
        } satisfies AllowedHostsDraft,
      }}
      orientation="horizontal"
    >
      {({ stepper }) => {
        const data: SandboxWizardData = {
          identity: stepper.metadata.get<SandboxIdentity>("identity") ?? undefined,
          packages: stepper.metadata.get<string[]>("packages") ?? undefined,
          mcps: stepper.metadata.get<SelectedMcpConnectionRef[]>("mcps") ?? undefined,
          skills: stepper.metadata.get<ResourceReference[]>("skills") ?? undefined,
          inference: stepper.metadata.get<SandboxInference>("models") ?? undefined,
          allowedHosts: stepper.metadata.get<AllowedHostsDraft>("allowedHosts") ?? undefined,
        }
        const currentIndex = stepper.state.current.index
        const currentStepId = stepper.state.current.data.id

        const completeNavigation = (request?: NavigationRequest) => {
          if (!request) {
            setDirection(1)
            stepper.navigation.next()
            return
          }

          if (request.kind === "prev") {
            setDirection(-1)
            stepper.navigation.prev()
            return
          }

          setDirection(request.index >= currentIndex ? 1 : -1)
          stepper.navigation.goTo(request.step)
        }

        const requestNavigation = (request: NavigationRequest) => {
          if (request.kind === "step" && request.index === currentIndex) {
            pendingNavigationRef.current = undefined
            return
          }

          if (
            currentStepId === "allowedHosts" ||
            (currentStepId === "models" &&
              (request.kind === "prev" ||
                (request.kind === "step" && request.index < currentIndex)))
          ) {
            pendingNavigationRef.current = undefined
            completeNavigation(request)
            return
          }

          pendingNavigationRef.current = request
          const form = document.getElementById(formIdByStep[currentStepId])
          if (!(form instanceof HTMLFormElement)) {
            return
          }
          form.requestSubmit()
        }

        return (
          <WizardShell
            steps={steps}
            currentIndex={currentIndex}
            currentStepId={currentStepId}
            direction={direction}
            canVisitStepAction={(step, index) => {
              if (index <= currentIndex) {
                return true
              }
              if (!data.identity) {
                return false
              }
              // The allowed-hosts step renders and submits the inference
              // draft, so skipping ahead without one crashes the form.
              if (step.id === "allowedHosts") {
                return Boolean(data.inference)
              }
              return true
            }}
            onStepSelectAction={(step, index) => {
              requestNavigation({ kind: "step", step: step.id, index })
            }}
          >
            {stepper.flow.switch({
              identity: () => (
                <IdentityForm
                  defaultValues={data.identity ?? initialIdentity}
                  lockName={mode === "update"}
                  onAdvanceAction={() => {
                    pendingNavigationRef.current = undefined
                  }}
                  onNext={(identity) => {
                    stepper.metadata.set("identity", identity)
                    completeNavigation(pendingNavigationRef.current)
                    pendingNavigationRef.current = undefined
                  }}
                />
              ),
              packages: () => (
                <PackageStep
                  installedPackages={initialPackages}
                  selectedPackages={data.packages ?? initialPackages}
                  onAdvanceAction={() => {
                    pendingNavigationRef.current = undefined
                  }}
                  onPrev={() => requestNavigation({ kind: "prev" })}
                  onNext={(packages) => {
                    stepper.metadata.set("packages", packages)
                    completeNavigation(pendingNavigationRef.current)
                    pendingNavigationRef.current = undefined
                  }}
                />
              ),
              mcps: () => (
                <McpStep
                  initialMcpConnectionRefs={data.mcps ?? initialMcpConnectionRefs}
                  initialNextPageToken={mcpConnectionsNextPageToken}
                  mcpConnections={mcpConnections}
                  workspaceId={scope.workspaceId}
                  onAdvanceAction={() => {
                    pendingNavigationRef.current = undefined
                  }}
                  onPrev={() => requestNavigation({ kind: "prev" })}
                  onNext={(mcpConnectionRefs) => {
                    stepper.metadata.set("mcps", mcpConnectionRefs)
                    completeNavigation(pendingNavigationRef.current)
                    pendingNavigationRef.current = undefined
                  }}
                />
              ),
              skills: () => (
                <SkillsStep
                  immutableSkills={immutableSkills}
                  initialNextPageToken={immutableSkillsNextPageToken}
                  initialSkills={data.skills ?? initialSkills}
                  workspaceId={scope.workspaceId}
                  onAdvanceAction={() => {
                    pendingNavigationRef.current = undefined
                  }}
                  onPrev={() => requestNavigation({ kind: "prev" })}
                  onNext={(skills) => {
                    stepper.metadata.set("skills", skills)
                    completeNavigation(pendingNavigationRef.current)
                    pendingNavigationRef.current = undefined
                  }}
                />
              ),
              models: () => (
                <ModelsStep
                  inferenceProviders={inferenceProviders}
                  inferencePools={inferencePools}
                  inference={data.inference}
                  providersHref={providersHref}
                  scope={scope}
                  onAdvanceAction={() => {
                    pendingNavigationRef.current = undefined
                  }}
                  onChangeAction={(inference) => {
                    stepper.metadata.set("models", inference ?? null)
                  }}
                  onPrev={() => requestNavigation({ kind: "prev" })}
                  onNext={() => {
                    completeNavigation(pendingNavigationRef.current)
                    pendingNavigationRef.current = undefined
                  }}
                />
              ),
              allowedHosts: () =>
                data.identity && data.inference ? (
                  <AllowedHostsStep
                    identity={data.identity}
                    initialAllowedHosts={data.allowedHosts?.allowedHosts ?? initialAllowedHosts}
                    initialDraft={data.allowedHosts?.draft ?? ""}
                    mcpConnectionRefs={data.mcps ?? initialMcpConnectionRefs}
                    packages={data.packages ?? initialPackages}
                    skills={data.skills ?? initialSkills}
                    inference={data.inference}
                    mode={mode}
                    scope={scope}
                    secretHostSuggestions={secretHostSuggestions}
                    onAllowedHostsChangeAction={(nextData) => {
                      stepper.metadata.set("allowedHosts", nextData)
                    }}
                    onPrev={() => requestNavigation({ kind: "prev" })}
                  />
                ) : null,
            })}
          </WizardShell>
        )
      }}
    </Stepper.Root>
  )
}
