"use client"

import { HoldToConfirm } from "@/components/interior/hold-to-confirm"

import { LoadingButton } from "@/components/interior/loading-button"
import { useMemo, useState, useTransition } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import { ClaudeAI, CodexLight } from "@ridemountainpig/svgl-react"
import {
  ArrowUpRight,
  Brain,
  Cable,
  CircleCheck,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { UserAvatar, UserIdentity } from "@/components/ui/avatar"
import { TruncatedText } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/interior/copy-button"
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
import { ClientGuardrailsPanel } from "@/components/guardrails/client-guardrails"
import { ApplicationAccessDetails } from "@/app/(account)/settings/applications/application-access-sheet"
import { externalAgentInput } from "@/data/schema"
import type { ExternalAgent } from "@/data/external-agents"
import type { OrganizationSummary } from "@/data/organizations"
import { watchExternalAgents, type Workspace } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  createExternalAgentAction,
  changeExternalAgentAction,
  listExternalAgentsAction,
} from "./actions"

const agentKinds = {
  claude: { label: "Claude Code", icon: ClaudeAI },
  codex: { label: "Codex", icon: CodexLight },
} as const

const layout = {
  name: { minWidth: 200, contentMaxWidth: 300 },
  user: { minWidth: 200, contentMaxWidth: 260, hiddenBelow: "sm" },
  status: { minWidth: 140, width: 160 },
  access: { minWidth: 180, contentMaxWidth: 260, hiddenBelow: "md" },
  created: { minWidth: 120, width: 140, hiddenBelow: "lg" },
  actions: { minWidth: 48, width: 48, align: "end" },
} satisfies Record<string, AdminColumnLayout>

export function ExternalAgents({
  orgSlug,
  workspaceSlug,
  workspace,
  organization,
  agents,
  delegationEnabled,
}: {
  orgSlug: string
  workspaceSlug: string
  workspace: Workspace
  organization: OrganizationSummary
  agents: ExternalAgent[]
  delegationEnabled: boolean
}) {
  "use no memo"

  const [selectedId, setSelectedId] = useState<string>()
  const [editor, setEditor] = useState<ExternalAgent | "new">()
  const [confirmation, setConfirmation] = useState<{
    agent: ExternalAgent
    operation: "disconnect" | "delete"
  }>()
  const [pending, startTransition] = useTransition()
  const query = useQuery(
    queryOptions({
      queryKey: [
        "watchExternalAgents",
        workspace.id,
        agents.map((agent) => agent.clientId),
      ] as const,
      placeholderData: agents,
      queryFn: streamedQuery<ExternalAgent[], ExternalAgent[]>({
        initialValue: agents,
        reducer: (_, agents) => agents,
        refetchMode: "reset",
        streamFn: async function* ({ signal }) {
          const result = await watchExternalAgents({
            baseUrl: await getGatewayBaseURL(),
            headers: { "X-AgentZ-Workspace-ID": workspace.id },
            signal,
          })
          for await (const _ of result.stream) {
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
  const rows = query.data ?? agents
  const selected = rows.find((agent) => agent.clientId === selectedId)
  const SelectedIcon = selected ? agentKinds[selected.kind].icon : undefined
  const columns = useMemo<ColumnDef<ExternalAgent>[]>(
    () => [
      {
        id: "name",
        header: "Agent",
        cell: ({ row: { original: agent } }) => {
          const Icon = agentKinds[agent.kind].icon
          return (
            <div className="flex min-w-0 items-center gap-3">
              <Icon
                aria-hidden="true"
                className="size-6 shrink-0"
                fill={agent.kind === "codex" ? "currentColor" : undefined}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium" title={agent.name}>
                  {agent.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {agentKinds[agent.kind].label}
                </span>
              </div>
            </div>
          )
        },
      },
      { id: "user", header: "User", cell: ({ row }) => <UserIdentity {...row.original.user} /> },
      {
        id: "status",
        header: "Status",
        cell: ({ row: { original: agent } }) => (
          <Badge variant={agent.connected ? "success" : "pending"}>
            {agent.connected ? <CircleCheck aria-hidden="true" data-icon="inline-start" /> : null}
            {agent.connected
              ? "Connected"
              : agent.previouslyConnected
                ? "Disconnected"
                : "Awaiting login"}
          </Badge>
        ),
      },
      {
        id: "access",
        header: "Approved access",
        cell: ({ row: { original: agent } }) => (
          <div className="flex flex-wrap gap-1.5">
            {agent.selection.models.length ? (
              <Badge variant="secondary">
                <Brain aria-hidden="true" data-icon="inline-start" />
                {agent.selection.models.length}{" "}
                {agent.selection.models.length === 1 ? "model" : "models"}
              </Badge>
            ) : null}
            {agent.selection.mcp.length ? (
              <Badge variant="secondary">
                <Cable aria-hidden="true" data-icon="inline-start" />
                {agent.selection.mcp.length} MCP
              </Badge>
            ) : null}
            {!agent.selection.models.length && !agent.selection.mcp.length ? (
              <span className="text-muted-foreground">
                {agent.connected ? "Identity only" : "No access granted"}
              </span>
            ) : null}
          </div>
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
        cell: ({ row: { original: agent } }) =>
          agent.canModify || agent.canDisconnect || agent.canDelete ? (
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
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    {agent.canModify ? (
                      <DropdownMenuItem onSelect={() => setEditor(agent)}>
                        <Pencil aria-hidden="true" />
                        Rename
                      </DropdownMenuItem>
                    ) : null}
                    {agent.canDisconnect && agent.connected ? (
                      <DropdownMenuItem
                        onSelect={() => setConfirmation({ agent, operation: "disconnect" })}
                      >
                        <Unplug aria-hidden="true" />
                        Disconnect
                      </DropdownMenuItem>
                    ) : null}
                    {agent.canDelete ? (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setConfirmation({ agent, operation: "delete" })}
                      >
                        <Trash2 aria-hidden="true" />
                        Delete agent
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null,
      },
    ],
    [pending]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ columns, data: rows, getCoreRowModel: getCoreRowModel() })

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
      toast.success(operation === "delete" ? "Agent deleted" : "Agent disconnected")
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
            <Button onClick={() => setEditor("new")}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add agent
            </Button>
          ) : undefined
        }
      />
      {!delegationEnabled ? (
        <div className="px-4 md:px-6">
          <Alert>
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
        onRowActivate={(agent) => setSelectedId(agent.clientId)}
        rowAriaLabel={(agent) => `Open ${agent.name}`}
        emptyState={
          <AdministrationState
            kind={workspace.capabilities.external_agents.create ? "welcome" : "empty"}
            title="No external agents"
          />
        }
      />
      {editor ? (
        <ExternalAgentEditor
          agent={editor === "new" ? undefined : editor}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onClose={() => setEditor(undefined)}
          onSaved={(clientId) => {
            setEditor(undefined)
            setSelectedId(clientId)
          }}
        />
      ) : null}
      {selected && !editor ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setSelectedId(undefined)
          }}
        >
          <SheetContent size="md" aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle className="flex min-w-0 items-center gap-3">
                {SelectedIcon ? (
                  <SelectedIcon
                    aria-hidden="true"
                    className="size-5 shrink-0"
                    fill={selected.kind === "codex" ? "currentColor" : undefined}
                  />
                ) : null}
                <span className="truncate">{selected.name}</span>
              </SheetTitle>
            </SheetHeader>
            <Tabs defaultValue="setup" className="min-h-0 flex-1 gap-4">
              <TabsList className="mx-4">
                <TabsTrigger value="setup">Setup</TabsTrigger>
                <TabsTrigger value="access">Access</TabsTrigger>
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
                  <ClientGuardrailsPanel
                    clientId={selected.clientId}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                  />
                </TabsContent>
              ) : null}
            </Tabs>
          </SheetContent>
        </Sheet>
      ) : null}
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmation(undefined)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.operation === "delete" ? "Delete agent?" : "Disconnect agent?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.operation === "delete"
                ? "This permanently deletes the agent, its traces and conversations, and revokes its identity, model and MCP access."
                : "Revoke this agent's identity, model and MCP access. Sign in again to reconnect."}{" "}
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
              <LoadingButton pending={pending} variant="destructive" onClick={confirmChange}>
                Disconnect
              </LoadingButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function ExternalAgentEditor({
  agent,
  orgSlug,
  workspaceSlug,
  onClose,
  onSaved,
}: {
  agent?: ExternalAgent
  orgSlug: string
  workspaceSlug: string
  onClose: () => void
  onSaved: (clientId: string) => void
}) {
  const form = useForm<z.infer<typeof externalAgentInput>>({
    resolver: zodResolver(externalAgentInput),
    defaultValues: { name: agent?.name ?? "", kind: agent?.kind ?? "claude" },
  })
  const [pending, startTransition] = useTransition()
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <SheetContent size="default">
        <SheetHeader>
          <SheetTitle>{agent ? "Rename agent" : "Add external agent"}</SheetTitle>
          {agent && <SheetDescription>Choose a name you recognize.</SheetDescription>}
        </SheetHeader>
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
            {!agent ? (
              <Controller
                name="kind"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="external-agent-kind">Agent</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={pending}>
                      <SelectTrigger
                        id="external-agent-kind"
                        aria-invalid={fieldState.invalid}
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {Object.entries(agentKinds).map(([value, { label, icon: Icon }]) => (
                            <SelectItem key={value} value={value}>
                              <Icon
                                aria-hidden="true"
                                fill={value === "codex" ? "currentColor" : undefined}
                              />
                              {label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            ) : null}
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
  const config = `externalAgents:
  - ${JSON.stringify(agent.name)}:
      provider: ${agent.kind}
      serverUrl: ${window.location.origin}
      clientID: ${agent.clientId}
`
  const profile = `'${agent.name.replaceAll("'", os === "windows" ? "''" : "'\\''")}'`
  const launch = `agentz launch ${agent.kind} --profile ${profile} --`
  const reconnect = agent.previouslyConnected && !agent.connected
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
        <FieldDescription>
          Requires {agent.kind === "claude" ? "Claude Code 2.1.299+" : "Codex 0.162.1+"}
        </FieldDescription>
        <Button variant="outline" asChild className="w-fit">
          <a
            href="https://github.com/accuknox/agentz/releases/latest"
            target="_blank"
            rel="noreferrer"
          >
            Download CLI
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
          command={
            reconnect && agent.kind === "codex" ? `agentz login codex --profile ${profile}` : launch
          }
          label="Copy launch command"
        />
        <FieldDescription>
          Sign in and choose models. Skip this step if you only need MCP.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>4. Connect MCP tools</FieldLabel>
        {agent.kind === "claude" ? (
          <SetupCommand
            command={`${launch} mcp add --transport http --scope user --client-id ${agent.clientId} --callback-port 8765 agentz ${window.location.origin}/api/mcp`}
            label="Copy MCP registration command"
          />
        ) : null}
        <SetupCommand command={`${launch} mcp login agentz`} label="Copy MCP login command" />
        <FieldDescription>Choose tools, prompts and resources in the browser</FieldDescription>
      </Field>
    </FieldGroup>
  )
}
