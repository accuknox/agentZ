"use client"

import { useMemo, useState, useTransition } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import {
  type ColumnDef,
  type ExpandedState,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query"
import {
  ArrowUpRight,
  Activity,
  Brain,
  Bot,
  Cable,
  CircleCheck,
  ChevronRight,
  Cloud,
  Clock3,
  Fingerprint,
  MoreHorizontal,
  RefreshCw,
  Pencil,
  Pause,
  Plus,
  TriangleAlert,
  Trash2,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { LensSourceIcon } from "@/components/lens-source-options"
import { UserAvatar, UserIdentity } from "@/components/ui/avatar"
import { TruncatedText } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/interior/copy-button"
import { RequestError } from "@/components/request-error"
import { HoldToConfirm } from "@/components/interior/hold-to-confirm"
import { LoadingButton } from "@/components/interior/loading-button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { RelativeDateTime } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CopilotStudio } from "./copilot-studio"
import { ExternalAgentGuardrailsPanel } from "@/components/guardrails/external-agent-guardrails"
import { ApplicationAccessDetails } from "@/app/(account)/settings/applications/application-access-sheet"
import { externalAgentInput } from "@/data/schema"
import type { CopilotStudioEnvironment, ExternalAgent } from "@/data/external-agents"
import { TablePagination } from "@/components/table-pagination"
import { Skeleton } from "@/components/ui/skeleton"
import type { OrganizationSummary } from "@/data/organizations"
import { watchExternalAgents, type Workspace } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { cn } from "@/lib/utils"
import {
  createExternalAgentAction,
  changeExternalAgentAction,
  listExternalAgentsAction,
  listCopilotStudioAgentsAction,
  loadExternalAgentAction,
} from "./actions"

const agentKinds = {
  codex: "Codex CLI",
  "chatgpt-desktop": "ChatGPT desktop",
  claude: "Claude code CLI",
  "claude-desktop": "Claude desktop",
  "github-copilot-desktop": "GitHub copilot desktop",
  "github-copilot-cli": "GitHub copilot CLI",
  "microsoft-copilot-studio": "Microsoft Copilot Studio",
} satisfies Record<ExternalAgent["kind"], string>

const layout = {
  name: { minWidth: 200, contentMaxWidth: 300 },
  user: { minWidth: 200, contentMaxWidth: 260, hiddenBelow: "sm" },
  status: { minWidth: 140, width: 160 },
  access: { minWidth: 180, contentMaxWidth: 260, hiddenBelow: "md" },
  created: { minWidth: 120, width: 140, hiddenBelow: "lg" },
  actions: { minWidth: 64, width: 64, align: "end" },
} satisfies Record<string, AdminColumnLayout>

type ExternalAgentRow =
  | { kind: "agent"; agent: ExternalAgent }
  | { kind: "copilot-studio"; environment: CopilotStudioEnvironment }

type ExternalAgentEditorState =
  | { kind: "new" }
  | { kind: "agent"; agent: ExternalAgent }
  | { kind: "copilot-studio"; environment: CopilotStudioEnvironment }

type ExternalAgentActionsProps = {
  agent: ExternalAgent
  pending: boolean
  onRename: (agent: ExternalAgent) => void
  onChange: (agent: ExternalAgent, operation: "disconnect" | "reconnect" | "delete") => void
}

export function ExternalAgents({
  orgSlug,
  workspaceSlug,
  workspace,
  organization,
  agents,
  integrations,
  delegationEnabled,
}: {
  orgSlug: string
  workspaceSlug: string
  workspace: Workspace
  organization: OrganizationSummary
  agents: ExternalAgent[]
  integrations: CopilotStudioEnvironment[]
  delegationEnabled: boolean
}) {
  "use no memo"

  const [selectedId, setSelectedId] = useState<string>()
  const [editor, setEditor] = useState<ExternalAgentEditorState>()
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const [confirmation, setConfirmation] = useState<{
    agent: ExternalAgent
    operation: "disconnect" | "reconnect" | "delete"
  }>()
  const [pending, startTransition] = useTransition()
  const confirmationText = {
    delete: {
      title: "Delete agent?",
      description:
        "Permanently delete this agent, its traces and conversations, and revoke its AgentZ identity and access.",
      label: "Delete agent",
      success: "Agent deleted",
    },
    disconnect: {
      title: "Disconnect agent?",
      description: "Stop accepting new requests from this agent. You can reconnect it later.",
      label: "Disconnect",
      success: "Agent disconnected",
    },
    reconnect: {
      title: "Reconnect agent?",
      description:
        "Resume Copilot Studio callbacks for this agent. Its environment connection must also be enabled.",
      label: "Reconnect",
      success: "Agent reconnected",
    },
  }[confirmation?.operation ?? "disconnect"]
  const queryClient = useQueryClient()
  const initialRows = { agents, integrations }
  const query = useQuery(
    queryOptions({
      queryKey: ["watchExternalAgents", orgSlug, workspaceSlug, workspace.id],
      placeholderData: initialRows,
      queryFn: streamedQuery<typeof initialRows, typeof initialRows>({
        initialValue: initialRows,
        reducer: (_, rows) => rows,
        refetchMode: "reset",
        streamFn: async function* ({ signal }) {
          const result = await watchExternalAgents({
            baseUrl: await getGatewayBaseURL(),
            headers: { "X-AgentZ-Workspace-ID": workspace.id },
            signal,
          })
          for await (const _ of result.stream) {
            void queryClient.invalidateQueries({
              predicate: (query) =>
                query.meta?.externalAgentScope === `${orgSlug}/${workspaceSlug}`,
            })
            yield await listExternalAgentsAction(orgSlug, workspaceSlug)
          }
          if (!signal.aborted) throw new Error("External agent updates disconnected.")
        },
      }),
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: true,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: Infinity,
    })
  )
  const data = query.data ?? initialRows
  const rows = useMemo<ExternalAgentRow[]>(
    () => [
      ...data.agents.map((agent): ExternalAgentRow => ({ kind: "agent", agent })),
      ...data.integrations.map(
        (environment): ExternalAgentRow => ({ kind: "copilot-studio", environment })
      ),
    ],
    [data]
  )
  const agentActions = useMemo<Omit<ExternalAgentActionsProps, "agent">>(
    () => ({
      pending,
      onRename: (agent) => setEditor({ kind: "agent", agent }),
      onChange: (agent, operation) => setConfirmation({ agent, operation }),
    }),
    [pending]
  )
  const columns = useMemo<ColumnDef<ExternalAgentRow>[]>(
    () => [
      {
        id: "name",
        header: "Agent",
        cell: ({ row }) => {
          const item = row.original
          if (item.kind === "copilot-studio") {
            const { environment } = item
            const count = environment.agentCount
            return (
              <div className="flex min-w-0 items-center gap-3">
                <LensSourceIcon kind="microsoft-copilot-studio" className="size-6 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium" title={environment.name}>
                    {environment.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    Microsoft Copilot Studio · {count} {count === 1 ? "agent" : "agents"}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={`${row.getIsExpanded() ? "Collapse" : "Expand"} ${environment.name}`}
                  aria-expanded={row.getIsExpanded()}
                  aria-controls={`copilot-studio-agents-${environment.id}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    row.toggleExpanded()
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <ChevronRight
                    className={cn(
                      "transition-transform motion-reduce:transition-none",
                      row.getIsExpanded() && "rotate-90"
                    )}
                  />
                </Button>
              </div>
            )
          }
          const { agent } = item
          return (
            <div className="flex min-w-0 items-center gap-3">
              <LensSourceIcon kind={agent.kind} className="size-6 shrink-0" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium" title={agent.name}>
                  {agent.name}
                </span>
                <span className="text-xs text-muted-foreground">{agentKinds[agent.kind]}</span>
              </div>
            </div>
          )
        },
      },
      {
        id: "user",
        header: "User",
        cell: ({ row }) => (
          <UserIdentity
            {...(row.original.kind === "agent"
              ? row.original.agent.user
              : row.original.environment.user)}
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          if (row.original.kind === "agent")
            return <ExternalAgentStatus agent={row.original.agent} />
          const { environment } = row.original
          const states = {
            pending: { label: "Awaiting validation", icon: Clock3 },
            success: { label: "Connected", icon: CircleCheck },
            destructive: { label: "Needs attention", icon: TriangleAlert },
            warning: { label: "Paused", icon: Pause },
          }
          let state: keyof typeof states = "pending"
          if (environment.validatedAt) state = "success"
          if (environment.runtimeError) state = "destructive"
          if (!environment.enabled) state = "warning"
          const { label, icon: StatusIcon } = states[state]
          return (
            <Badge variant={state}>
              <StatusIcon aria-hidden data-icon="inline-start" />
              {label}
            </Badge>
          )
        },
      },
      {
        id: "access",
        header: "Approved access",
        cell: ({ row }) => {
          if (row.original.kind === "copilot-studio")
            return (
              <Badge variant="secondary">
                <Cloud aria-hidden data-icon="inline-start" />
                Microsoft managed
              </Badge>
            )
          const { agent } = row.original
          return (
            <div className="flex flex-wrap gap-1.5">
              {agent.selection.models.length ? (
                <Badge variant="secondary">
                  <Brain aria-hidden data-icon="inline-start" />
                  {agent.selection.models.length}{" "}
                  {agent.selection.models.length === 1 ? "model" : "models"}
                </Badge>
              ) : null}
              {agent.selection.mcp.length ? (
                <Badge variant="secondary">
                  <Cable aria-hidden data-icon="inline-start" />
                  {agent.selection.mcp.length} MCP
                </Badge>
              ) : null}
              {!agent.selection.models.length && !agent.selection.mcp.length ? (
                <span className="text-muted-foreground">
                  {agent.connected ? "Identity only" : "No access granted"}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "created",
        header: "Added",
        cell: ({ row }) => (
          <RelativeDateTime
            value={
              row.original.kind === "agent"
                ? row.original.agent.createdAt
                : row.original.environment.createdAt
            }
          />
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          if (row.original.kind === "agent")
            return <ExternalAgentActions agent={row.original.agent} {...agentActions} />
          const { environment } = row.original
          if (!environment.canModify) return null
          return (
            <div
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${environment.name}`}
                  >
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onSelect={() => setEditor({ kind: "copilot-studio", environment })}
                    >
                      <Pencil aria-hidden />
                      Manage connection
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [agentActions]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) =>
      row.kind === "agent" ? row.agent.clientId : `copilot-studio:${row.environment.id}`,
    getRowCanExpand: (row) => row.original.kind === "copilot-studio",
    state: { expanded },
    onExpandedChange: setExpanded,
    autoResetExpanded: false,
  })

  function confirmChange() {
    if (!confirmation) return
    const { agent, operation } = confirmation
    startTransition(async () => {
      const result = await changeExternalAgentAction(
        orgSlug,
        workspaceSlug,
        agent.clientId,
        operation
      )
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      setConfirmation(undefined)
      if (operation === "delete") setSelectedId(undefined)
      toast.success(confirmationText.success)
    })
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader
        title="External agents"
        scope={{
          kind: "workspace",
          organizationName: organization.name,
          workspaceName: workspace.name,
        }}
        actions={
          workspace.capabilities.external_agents.create ? (
            <Button onClick={() => setEditor({ kind: "new" })}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add external agent
            </Button>
          ) : undefined
        }
      />
      {!delegationEnabled ? (
        <div className="px-4 md:px-6">
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              Your organization has disabled external model and MCP access. An organization admin
              must enable resource delegation before you can grant access.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <AdminDataGrid
        ariaLabel="External agents"
        rows={rows}
        table={table}
        layout={layout}
        tableClassName="[&>tbody>tr[aria-expanded=true]]:bg-primary/5"
        subRowClassName="p-0"
        onRowActivate={(row) => {
          if (row.kind === "copilot-studio") {
            table.getRow(`copilot-studio:${row.environment.id}`).toggleExpanded()
            return
          }
          setSelectedId(row.agent.clientId)
        }}
        rowAriaLabel={(row) =>
          row.kind === "agent" ? `Open ${row.agent.name}` : `Show agents in ${row.environment.name}`
        }
        rowAriaExpanded={(row) =>
          row.kind === "copilot-studio"
            ? table.getRow(`copilot-studio:${row.environment.id}`).getIsExpanded()
            : undefined
        }
        renderSubRow={(row) =>
          row.kind === "copilot-studio" &&
          table.getRow(`copilot-studio:${row.environment.id}`).getIsExpanded() ? (
            <CopilotStudioAgents
              environment={row.environment}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              workspaceId={workspace.id}
              actions={agentActions}
              onActivate={setSelectedId}
            />
          ) : null
        }
        emptyState={
          <AdministrationState
            kind={workspace.capabilities.external_agents.create ? "welcome" : "empty"}
            title="No external agents"
          />
        }
      />
      {editor ? (
        <ExternalAgentEditor
          agent={editor.kind === "agent" ? editor.agent : undefined}
          environment={editor.kind === "copilot-studio" ? editor.environment : undefined}
          canManageCopilotStudio={organization.superadmin || workspace.capabilities.administer}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onClose={() => setEditor(undefined)}
          onStudioSaved={(id) =>
            setExpanded((current) =>
              current === true ? current : { ...current, [`copilot-studio:${id}`]: true }
            )
          }
          onSaved={(clientId) => {
            setEditor(undefined)
            setSelectedId(clientId)
          }}
        />
      ) : null}
      {selectedId && !editor ? (
        <ExternalAgentDetails
          clientId={selectedId}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspace={workspace}
          organization={organization}
          initialAgent={data.agents.find((agent) => agent.clientId === selectedId)}
          onClose={() => setSelectedId(undefined)}
        />
      ) : null}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmationText.title}</DialogTitle>
            <DialogDescription>
              {confirmationText.description}{" "}
              {confirmation?.operation === "delete" &&
              confirmation.agent.kind === "microsoft-copilot-studio"
                ? "This agent will not be rediscovered automatically. "
                : null}
              Requests already running may finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            {confirmation?.operation === "delete" ? (
              <HoldToConfirm pending={pending} variant="destructive" onConfirm={confirmChange}>
                Hold to delete agent
              </HoldToConfirm>
            ) : (
              <LoadingButton
                pending={pending}
                variant={confirmation?.operation === "reconnect" ? "default" : "destructive"}
                onClick={confirmChange}
              >
                {confirmationText.label}
              </LoadingButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function ExternalAgentStatus({ agent }: { agent: ExternalAgent }) {
  if (agent.kind === "microsoft-copilot-studio" && !agent.disabled && !agent.environmentEnabled)
    return (
      <Badge variant="warning">
        <Pause aria-hidden data-icon="inline-start" />
        Paused
      </Badge>
    )
  return (
    <Badge variant={agent.connected ? "success" : "pending"}>
      {agent.connected ? <CircleCheck aria-hidden data-icon="inline-start" /> : null}
      {agent.connected
        ? "Connected"
        : agent.previouslyConnected || agent.kind === "microsoft-copilot-studio"
          ? "Disconnected"
          : "Awaiting login"}
    </Badge>
  )
}

function ExternalAgentActions({ agent, pending, onRename, onChange }: ExternalAgentActionsProps) {
  if (!agent.canModify && !agent.canDisconnect && !agent.canDelete) return null
  const disconnectable =
    agent.kind === "microsoft-copilot-studio" ? !agent.disabled : agent.connected
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={`Actions for ${agent.name}`}
          >
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {agent.canModify ? (
              <DropdownMenuItem onSelect={() => onRename(agent)}>
                <Pencil aria-hidden />
                Rename
              </DropdownMenuItem>
            ) : null}
            {agent.canDisconnect && disconnectable ? (
              <DropdownMenuItem onSelect={() => onChange(agent, "disconnect")}>
                <Unplug aria-hidden />
                Disconnect
              </DropdownMenuItem>
            ) : null}
            {agent.kind === "microsoft-copilot-studio" && agent.disabled && agent.canModify ? (
              <DropdownMenuItem onSelect={() => onChange(agent, "reconnect")}>
                <RefreshCw aria-hidden />
                Reconnect
              </DropdownMenuItem>
            ) : null}
            {agent.canDelete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onChange(agent, "delete")}>
                <Trash2 aria-hidden />
                Delete agent
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const studioAgentLayout = {
  name: { minWidth: 180, width: 260, contentMaxWidth: 260 },
  agentId: { minWidth: 200, width: 240, contentMaxWidth: 240, hiddenBelow: "md" },
  status: { minWidth: 120, width: 140 },
  lastActive: { minWidth: 130, width: 150 },
  created: { minWidth: 130, width: 150, hiddenBelow: "lg" },
  actions: { minWidth: 64, width: 64, align: "end" },
} satisfies Record<string, AdminColumnLayout>

function CopilotStudioAgents({
  environment,
  orgSlug,
  workspaceSlug,
  workspaceId,
  actions,
  onActivate,
}: {
  environment: CopilotStudioEnvironment
  orgSlug: string
  workspaceSlug: string
  workspaceId: string
  actions: Omit<ExternalAgentActionsProps, "agent">
  onActivate: (id: string) => void
}) {
  "use no memo"

  const [pageTokens, setPageTokens] = useState([""])
  const pageToken = pageTokens.at(-1) ?? ""
  const query = useQuery(
    queryOptions({
      queryKey: [
        "copilotStudioAgents",
        orgSlug,
        workspaceSlug,
        workspaceId,
        environment.id,
        pageToken,
      ],
      meta: { externalAgentScope: `${orgSlug}/${workspaceSlug}` },
      queryFn: () =>
        listCopilotStudioAgentsAction(orgSlug, workspaceSlug, environment.id, pageToken),
      refetchInterval: environment.enabled && environment.agentCount > 0 ? 15_000 : false,
      placeholderData: keepPreviousData,
      retry: false,
    })
  )
  const agents = query.data?.agents ?? []
  const loading = query.isLoading || query.isPlaceholderData
  const columns = useMemo<ColumnDef<ExternalAgent>[]>(
    () => [
      {
        id: "name",
        header: "Studio agent",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot aria-hidden className="size-4" />
            </span>
            <TruncatedText className="block min-w-0 font-medium" value={row.original.name} />
          </div>
        ),
      },
      {
        id: "agentId",
        header: () => (
          <span className="inline-flex items-center gap-1.5">
            <Fingerprint aria-hidden className="size-3.5" />
            Agent ID
          </span>
        ),
        cell: ({ row }) => (
          <TruncatedText
            className="block font-mono text-xs"
            value={row.original.copilotStudioAgentId ?? "—"}
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <ExternalAgentStatus agent={row.original} />,
      },
      {
        id: "lastActive",
        header: () => (
          <span className="inline-flex items-center gap-1.5">
            <Activity aria-hidden className="size-3.5 text-muted-foreground" />
            Last active
          </span>
        ),
        cell: ({ row }) =>
          row.original.lastActiveAt ? (
            <RelativeDateTime value={row.original.lastActiveAt} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "created",
        header: "Added",
        cell: ({ row }) => <RelativeDateTime value={row.original.createdAt} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <ExternalAgentActions agent={row.original} {...actions} />,
      },
    ],
    [actions]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: agents,
    getRowId: (agent) => agent.clientId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })
  if (query.error)
    return (
      <RequestError
        title="Agents unavailable"
        description={query.error.message}
        onRetry={async () => {
          await query.refetch()
        }}
      />
    )
  return (
    <div
      id={`copilot-studio-agents-${environment.id}`}
      className="min-w-0 border-y bg-primary/3 [contain:inline-size]"
      style={{
        backgroundImage:
          "radial-gradient(color-mix(in oklab, var(--primary) 14%, transparent) 0.5px, transparent 0.5px)",
        backgroundSize: "8px 8px",
      }}
    >
      <AdminDataGrid
        ariaLabel={`${environment.name} agents`}
        rows={agents}
        table={table}
        layout={studioAgentLayout}
        className="gap-0"
        tableClassName="w-full table-fixed [&>tbody>tr]:bg-background/70 [&>tbody>tr:hover]:bg-primary/5 [&>thead>tr]:bg-transparent [&>thead>tr:hover]:bg-transparent"
        loading={loading}
        loadingRows={Math.max(
          1,
          Math.min(10, environment.agentCount - (pageTokens.length - 1) * 10)
        )}
        onRowActivate={(agent) => onActivate(agent.clientId)}
        rowAriaLabel={(agent) => `Open ${agent.name}`}
        emptyState={
          <AdministrationState
            kind="empty"
            title="No Studio agents yet"
            description="Agents appear after their first tool call."
          />
        }
        pagination={
          environment.agentCount > 0 || pageTokens.length > 1 ? (
            <div className="flex items-center justify-between gap-3 px-4 py-2">
              {loading ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span className="text-xs text-muted-foreground tabular-nums">
                  Page {pageTokens.length} · {agents.length}{" "}
                  {agents.length === 1 ? "agent" : "agents"}
                </span>
              )}
              <TablePagination
                canGoPrevious={pageTokens.length > 1}
                canGoNext={Boolean(query.data?.nextPageToken)}
                goPrevious={() => setPageTokens((tokens) => tokens.slice(0, -1))}
                goNext={() => {
                  const next = query.data?.nextPageToken
                  if (next) setPageTokens((tokens) => [...tokens, next])
                }}
                pending={query.isFetching}
              />
            </div>
          ) : null
        }
      />
    </div>
  )
}

function ExternalAgentDetails({
  clientId,
  orgSlug,
  workspaceSlug,
  workspace,
  organization,
  initialAgent,
  onClose,
}: {
  clientId: string
  orgSlug: string
  workspaceSlug: string
  workspace: Workspace
  organization: OrganizationSummary
  initialAgent?: ExternalAgent
  onClose: () => void
}) {
  const query = useQuery(
    queryOptions({
      queryKey: ["externalAgentDetails", orgSlug, workspaceSlug, workspace.id, clientId],
      meta: { externalAgentScope: `${orgSlug}/${workspaceSlug}` },
      queryFn: () => loadExternalAgentAction(orgSlug, workspaceSlug, clientId),
      placeholderData: initialAgent,
      retry: false,
    })
  )
  const selected = query.data
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent size="md" aria-describedby={undefined}>
        {selected ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex min-w-0 items-center gap-3">
                <LensSourceIcon kind={selected.kind} className="size-5 shrink-0" />
                <span className="truncate">{selected.name}</span>
              </SheetTitle>
            </SheetHeader>
            <Tabs defaultValue="setup" className="min-h-0 flex-1 gap-4">
              <TabsList className="mx-4">
                <TabsTrigger value="setup">
                  {selected.kind === "microsoft-copilot-studio" ? "Connection" : "Setup"}
                </TabsTrigger>
                {selected.kind !== "microsoft-copilot-studio" ? (
                  <TabsTrigger value="access">Access</TabsTrigger>
                ) : null}
                {(organization.superadmin || workspace.capabilities.administer) &&
                selected.connected ? (
                  <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="setup" className="overflow-y-auto">
                <AgentSetup agent={selected} />
              </TabsContent>
              <TabsContent value="access" className="overflow-y-auto">
                {selected.connected ? (
                  <ApplicationAccessDetails
                    workspaceScoped
                    identity={
                      <div className="flex min-w-0 items-center gap-2">
                        <UserAvatar {...selected.user} />
                        <TruncatedText value={selected.user.email} />
                      </div>
                    }
                    application={{
                      clientId: selected.clientId,
                      name: selected.name,
                      owner: organization.name,
                      scopes: selected.scopes,
                      createdAt: selected.connectedAt ?? selected.createdAt,
                      access:
                        selected.selection.models.length || selected.selection.mcp.length
                          ? [
                              {
                                organizationId: organization.id,
                                organization: organization.name,
                                selection: selected.selection,
                              },
                            ]
                          : [],
                    }}
                    workspaces={{ [workspace.id]: workspace.name }}
                  />
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Unplug aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>No access granted</EmptyTitle>
                      <EmptyDescription>
                        Sign in to choose models and MCP tools for this agent.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
              {(organization.superadmin || workspace.capabilities.administer) &&
              selected.connected ? (
                <TabsContent className="overflow-y-auto" value="guardrails">
                  <ExternalAgentGuardrailsPanel
                    clientId={selected.clientId}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                  />
                </TabsContent>
              ) : null}
            </Tabs>
          </>
        ) : query.error ? (
          <>
            <SheetHeader>
              <SheetTitle>Agent unavailable</SheetTitle>
            </SheetHeader>
            <RequestError
              title="Agent unavailable"
              description={query.error.message}
              onRetry={async () => {
                await query.refetch()
              }}
            />
          </>
        ) : (
          <div role="status" aria-label="Loading agent" className="flex flex-col gap-4">
            <SheetHeader>
              <SheetTitle>
                <Skeleton className="h-5 w-48" />
              </SheetTitle>
            </SheetHeader>
            <Skeleton className="mx-4 h-8 w-52" />
            <FieldGroup className="p-4 pt-0" aria-hidden>
              <Field>
                <FieldLabel>Agent ID</FieldLabel>
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 flex-1" />
                  <Skeleton className="size-8 shrink-0" />
                </div>
              </Field>
              {["Last active", "Added"].map((label) => (
                <Field key={label}>
                  <FieldLabel>{label}</FieldLabel>
                  <Skeleton className="h-5 w-24" />
                </Field>
              ))}
            </FieldGroup>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ExternalAgentEditor({
  agent,
  environment,
  canManageCopilotStudio,
  orgSlug,
  workspaceSlug,
  onClose,
  onSaved,
  onStudioSaved,
}: {
  agent?: ExternalAgent
  environment?: CopilotStudioEnvironment
  canManageCopilotStudio: boolean
  orgSlug: string
  workspaceSlug: string
  onClose: () => void
  onSaved: (clientId: string) => void
  onStudioSaved: (integrationId: string) => void
}) {
  const form = useForm<z.infer<typeof externalAgentInput>>({
    resolver: zodResolver(externalAgentInput),
    defaultValues: {
      name: agent?.name ?? "",
      kind: environment ? "microsoft-copilot-studio" : (agent?.kind ?? "codex"),
    },
  })
  const kind = useWatch({ control: form.control, name: "kind" })
  const [studioId, setStudioId] = useState(environment?.id)
  const [pending, startTransition] = useTransition()
  const studio = !agent && kind === "microsoft-copilot-studio"
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <SheetContent
        size="default"
        className={studio ? "sm:w-[34.56rem] sm:max-w-[34.56rem]" : undefined}
      >
        <SheetHeader>
          <SheetTitle>
            {agent ? "Rename agent" : (environment?.name ?? "Add external agent")}
          </SheetTitle>
          {agent ? <SheetDescription>Choose a name you recognize.</SheetDescription> : null}
        </SheetHeader>
        {!agent ? (
          <FieldGroup className="shrink-0 p-4">
            <Controller
              name="kind"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="external-agent-kind" required>
                    Agent
                  </FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={pending || studioId !== undefined}
                  >
                    <SelectTrigger
                      id="external-agent-kind"
                      aria-invalid={fieldState.invalid}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {externalAgentInput.shape.kind.options.map((value) => (
                          <SelectItem
                            key={value}
                            value={value}
                            disabled={
                              value === "microsoft-copilot-studio" && !canManageCopilotStudio
                            }
                          >
                            <LensSourceIcon kind={value} />
                            {agentKinds[value]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        ) : null}
        {studio ? (
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
            {canManageCopilotStudio ? (
              <CopilotStudio
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                integrationId={studioId}
                pending={pending}
                startTransition={startTransition}
                onSaved={(id) => {
                  setStudioId(id)
                  onStudioSaved(id)
                }}
              />
            ) : (
              <AdministrationState kind="forbidden" />
            )}
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={form.handleSubmit((input) =>
              startTransition(async () => {
                if (agent) {
                  const result = await changeExternalAgentAction(
                    orgSlug,
                    workspaceSlug,
                    agent.clientId,
                    "rename",
                    input.name
                  )
                  if ("error" in result) {
                    form.setError("root", { message: result.error })
                    return
                  }
                  toast.success("Agent renamed")
                  onSaved(agent.clientId)
                  return
                }
                const result = await createExternalAgentAction(orgSlug, workspaceSlug, input)
                if ("error" in result) {
                  form.setError("root", { message: result.error })
                  return
                }
                toast.success("Agent added")
                onSaved(result.clientId)
              })
            )}
          >
            <FieldGroup className="overflow-y-auto p-4">
              <Field data-invalid={!!form.formState.errors.name}>
                <FieldLabel htmlFor="external-agent-name">Name</FieldLabel>
                <Input
                  id="external-agent-name"
                  placeholder="e.g. Work laptop"
                  autoComplete="off"
                  maxLength={100}
                  disabled={pending}
                  aria-invalid={!!form.formState.errors.name}
                  {...form.register("name")}
                />
                <FieldError errors={[form.formState.errors.name]} />
              </Field>
              <FieldError errors={[form.formState.errors.root]} />
            </FieldGroup>
            <SheetFooter className="mt-auto border-t">
              <LoadingButton pending={pending} type="submit">
                {agent ? "Save" : "Add agent"}
              </LoadingButton>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}

function SetupCommand({ command, label }: { command: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border bg-muted/40 p-3">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
        {command}
      </pre>
      <CopyButton content={command} label={label} />
    </div>
  )
}

function AgentSetup({ agent }: { agent: ExternalAgent }) {
  const [os, setOS] = useState("linux")
  if (agent.kind === "microsoft-copilot-studio")
    return (
      <FieldGroup className="p-4 pt-0">
        <Field>
          <FieldLabel>Agent ID</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={agent.copilotStudioAgentId ?? ""}
              aria-label="Agent ID to copy"
            />
            <CopyButton content={agent.copilotStudioAgentId ?? ""} label="Copy agent ID" />
          </div>
        </Field>
        <Field>
          <FieldLabel>Last active</FieldLabel>
          <FieldDescription>
            {agent.lastActiveAt ? (
              <RelativeDateTime value={agent.lastActiveAt} />
            ) : (
              "No activity yet"
            )}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Added</FieldLabel>
          <FieldDescription>
            <RelativeDateTime value={agent.createdAt} />
          </FieldDescription>
        </Field>
      </FieldGroup>
    )
  const config = `externalAgents:
  - ${JSON.stringify(agent.name)}:
      provider: ${agent.kind}
      serverUrl: ${window.location.origin}
      clientID: ${agent.clientId}
`
  const profile = `'${agent.name.replaceAll("'", os === "windows" ? "''" : "'\\''")}'`
  const provider = agent.kind === "github-copilot-cli" ? "copilot" : agent.kind
  const launch = `agentz launch ${provider} --profile ${profile} --`
  const login = `agentz login ${provider} --profile ${profile}`
  const version = {
    claude: "Claude Code 2.1.299+",
    codex: "Codex 0.162.1+",
    "github-copilot-cli": "GitHub Copilot CLI 1.0.106+",
    "github-copilot-desktop": "GitHub Copilot Desktop 1.1.35+ and a GitHub account",
    "chatgpt-desktop": "ChatGPT Desktop with Codex mode, plus Codex CLI 0.162.1+",
    "claude-desktop": "Claude Desktop with third-party inference configuration",
  }[agent.kind]
  const desktop =
    agent.kind === "chatgpt-desktop" ||
    agent.kind === "claude-desktop" ||
    agent.kind === "github-copilot-desktop"
  const separateLogin = desktop || agent.kind === "github-copilot-cli"
  const reconnect = agent.previouslyConnected && !agent.connected
  let modelInstructions = "Sign in and choose models. Skip this step if you only need MCP."
  if (agent.kind === "github-copilot-cli")
    modelInstructions = "Copilot conversations require a model grant. MCP access is separate."
  if (desktop)
    modelInstructions =
      "Sign in and choose models for desktop conversations. MCP access is separate."
  return (
    <FieldGroup className="p-4 pt-0">
      {!agent.own ? (
        <Alert>
          <AlertDescription>
            This agent belongs to {agent.user.name}. Its owner must complete login.
          </AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <FieldLabel>1. Install the CLI</FieldLabel>
        <FieldDescription>Requires {version}</FieldDescription>
        <Button variant="outline" asChild className="w-fit">
          <a
            href="https://github.com/accuknox/agentz/releases/latest"
            target="_blank"
            rel="noreferrer"
          >
            Download AgentZ CLI
            <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
          </a>
        </Button>
      </Field>
      <Field>
        <FieldLabel>2. Save your configuration</FieldLabel>
        <Tabs value={os} onValueChange={setOS}>
          <TabsList>
            <TabsTrigger value="linux">Linux</TabsTrigger>
            <TabsTrigger value="macos">macOS</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
          </TabsList>
          <TabsContent value="linux">
            <FieldDescription>
              <code>$XDG_CONFIG_HOME/agentz/config.yaml</code> or{" "}
              <code>~/.config/agentz/config.yaml</code>
            </FieldDescription>
          </TabsContent>
          <TabsContent value="macos">
            <FieldDescription>
              <code>~/Library/Application Support/agentz/config.yaml</code>
            </FieldDescription>
          </TabsContent>
          <TabsContent value="windows">
            <FieldDescription>
              <code>%APPDATA%\agentz\config.yaml</code>. Use PowerShell for the commands below.
            </FieldDescription>
          </TabsContent>
        </Tabs>
        <SetupCommand command={config} label="Copy configuration" />
        <FieldDescription>
          Add this entry to <code>externalAgents</code>. Keep your existing profiles.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{reconnect ? "3. Reconnect models" : "3. Connect models"}</FieldLabel>
        {reconnect && agent.kind === "claude" ? (
          <SetupCommand command={`${launch} auth logout`} label="Copy logout command" />
        ) : null}
        <SetupCommand
          command={separateLogin || (reconnect && agent.kind === "codex") ? login : launch}
          label="Copy model connection command"
        />
        <FieldDescription>{modelInstructions}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>4. Connect MCP tools</FieldLabel>
        {agent.kind === "claude" ? (
          <SetupCommand
            command={`${launch} mcp add --transport http --scope user --client-id ${agent.clientId} --callback-port 8765 agentz ${window.location.origin}/api/mcp`}
            label="Copy MCP registration command"
          />
        ) : null}
        <SetupCommand
          command={separateLogin ? `${login} --mcp` : `${launch} mcp login agentz`}
          label="Copy MCP login command"
        />
        <FieldDescription>Choose tools, prompts and resources in the browser</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>5. Launch {agentKinds[agent.kind]}</FieldLabel>
        <SetupCommand
          command={`agentz launch ${provider} --profile ${profile}`}
          label="Copy launch command"
        />
        {agent.kind === "claude-desktop" ? (
          <>
            <FieldDescription>Quit Claude Desktop before running this command.</FieldDescription>
            <FieldDescription>
              Use <code>desktop-connection.json</code> at the path printed in the terminal.
            </FieldDescription>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
              <li>Open Help &gt; Troubleshooting &gt; Enable Developer Mode.</li>
              <li>Open Developer &gt; Configure Third-Party Inference.</li>
              <li>Import the setup file and confirm its name.</li>
              <li>Click Apply Changes.</li>
            </ol>
          </>
        ) : null}
        {agent.kind === "github-copilot-desktop" ? (
          <>
            <FieldDescription>
              Quit GitHub Copilot Desktop before running this command.
            </FieldDescription>
            <FieldDescription>
              Open <code>desktop-connection.json</code> at the path printed in the terminal. Add its
              settings manually in the app.
            </FieldDescription>
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
              <li>Sign in to GitHub.</li>
              <li>Open Settings &gt; Model providers.</li>
              <li>
                Add each provider in the file. Choose Custom endpoint for <code>openai</code> or
                Anthropic for <code>anthropic</code>.
              </li>
              <li>
                Copy <code>baseUrl</code> and <code>apiKey</code> into the matching fields. For
                Custom endpoint, choose the API format shown in <code>wireApi</code>.
              </li>
              <li>
                Add each model. Copy <code>id</code> into Model ID and <code>name</code> into
                Display name.
              </li>
              <li>Select an AgentZ model and start a local chat.</li>
            </ol>
          </>
        ) : null}
      </Field>
    </FieldGroup>
  )
}
