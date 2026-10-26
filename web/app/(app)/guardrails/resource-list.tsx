"use client"

import { useEffect, useState, useTransition, type ComponentProps, type ReactNode } from "react"
import { useRouter, useSelectedLayoutSegments } from "next/navigation"
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import {
  CheckCircle2,
  CircleDashed,
  Eye,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plus,
  BrickWallShield,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  listGuardrailConnections,
  type GuardrailConnection,
  type GuardrailPolicy,
  type GuardrailStatus,
} from "@/lib/gateway/client"
import { LoadingButton } from "@/components/interior/loading-button"
import { PolicyEditor } from "./policy-editor"
import {
  deleteGuardrailConnectionAction,
  deleteGuardrailPolicyAction,
  type GuardrailActionScope,
} from "@/data/guardrail.actions"
import { AdminDataGrid } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { HoldToConfirm } from "@/components/interior/hold-to-confirm"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConnectionSheet } from "./connection-sheet"
import { GuardrailProviderIcon, guardrailProviderLabels } from "./provider-shared"

const policyColumn = createColumnHelper<GuardrailPolicy>()
const connectionColumn = createColumnHelper<GuardrailConnection>()
const statusMeta = {
  Pending: { icon: CircleDashed, label: "Applying", variant: "pending" },
  Ready: { icon: CheckCircle2, label: "Configured", variant: "success" },
  Error: { icon: XCircle, label: "Error", variant: "destructive" },
} satisfies Record<
  GuardrailStatus["state"],
  {
    icon: LucideIcon
    label: string
    variant: ComponentProps<typeof Badge>["variant"]
  }
>

type NewGuardrailPolicyButtonProps = {
  scope: GuardrailActionScope
  canReadConnections: boolean
  canCreateConnection: boolean
}

export function NewGuardrailPolicyButton(props: NewGuardrailPolicyButtonProps) {
  const { scope, canReadConnections, canCreateConnection } = props

  const [connections, setConnections] = useState<GuardrailConnection[]>()
  const [pending, startTransition] = useTransition()

  return (
    <>
      <LoadingButton
        pending={pending}
        type="button"
        onClick={() =>
          startTransition(async () => {
            try {
              const result = canReadConnections
                ? await listGuardrailConnections({
                    headers: scope.workspaceId
                      ? { "X-AgentZ-Workspace-ID": scope.workspaceId }
                      : undefined,
                    throwOnError: true,
                  })
                : undefined
              setConnections(result?.data.items ?? [])
            } catch {
              toast.error("Could not load guardrail connections")
            }
          })
        }
      >
        <Plus />
        New policy
      </LoadingButton>
      {connections ? (
        <PolicyEditor
          canCreateConnection={canCreateConnection}
          connections={connections}
          scope={scope}
          onCancel={() => setConnections(undefined)}
          onSaved={() => setConnections(undefined)}
        />
      ) : null}
    </>
  )
}

export function NewGuardrailConnectionButton({ scope }: { scope: GuardrailActionScope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} type="button">
        <Plus />
        New connection
      </Button>
      {open ? <ConnectionSheet scope={scope} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

type GuardrailPolicyListProps = {
  canCreate: boolean
  canCreateConnection: boolean
  connections: GuardrailConnection[]
  policies: GuardrailPolicy[]
  scope: GuardrailActionScope
}

export function GuardrailPolicyList(props: GuardrailPolicyListProps) {
  "use no memo"
  const { canCreate, canCreateConnection, connections, policies, scope } = props

  const [editing, setEditing] = useState<GuardrailPolicy>()
  const [deleting, setDeleting] = useState<GuardrailPolicy>()
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: policies,
    getCoreRowModel: getCoreRowModel(),
    columns: [
      policyColumn.accessor("displayName", {
        header: "Name",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <BrickWallShield aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-medium">{row.original.displayName}</span>
            {scope.workspaceId !== undefined && row.original.scope === "Organisation" ? (
              <Badge variant="secondary">Organization</Badge>
            ) : null}
            {row.original.mandatory ? (
              <Badge variant="secondary">
                <LockKeyhole aria-hidden data-icon="inline-start" />
                Required
              </Badge>
            ) : null}
          </div>
        ),
      }),
      policyColumn.accessor("description", {
        header: "Description",
        cell: ({ getValue }) => (
          <span className="block truncate text-muted-foreground" title={getValue()}>
            {getValue() || "—"}
          </span>
        ),
      }),
      policyColumn.accessor("checks", {
        header: "Checks",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.checks.filter((check) => check.phase === "input").length} input ·{" "}
            {row.original.checks.filter((check) => check.phase === "output").length} output
          </span>
        ),
      }),
      policyColumn.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => <GuardrailStatusBadge status={getValue()} />,
      }),
      policyColumn.display({
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Actions for ${row.original.displayName}`}
                  className="size-8"
                  size="icon"
                  variant="ghost"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                    {row.original.canModify ? <Pencil /> : <Eye />}
                    {row.original.canModify ? "Edit" : "View"}
                  </DropdownMenuItem>
                  {row.original.canDelete ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleting(row.original)}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }),
    ],
  })
  return (
    <>
      <AdminDataGrid
        ariaLabel="Guardrail policies"
        emptyState={
          <AdministrationState
            kind={canCreate ? "welcome" : "empty"}
            title="No guardrail policies"
          />
        }
        layout={{
          displayName: { minWidth: 256, contentMaxWidth: 400 },
          description: { minWidth: 200, contentMaxWidth: 320, hiddenBelow: "lg" },
          checks: { minWidth: 160, width: 160 },
          status: { minWidth: 128, width: 128 },
          actions: { minWidth: 64, width: 64, align: "end" },
        }}
        onRowActivate={setEditing}
        rowAriaLabel={(policy) => `View ${policy.displayName}`}
        rows={policies}
        table={table}
      />
      {editing ? (
        <PolicyEditor
          canCreateConnection={canCreateConnection}
          connections={connections}
          policy={editing}
          scope={scope}
          onCancel={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      ) : null}
      {deleting ? (
        <DeleteGuardrail
          name={deleting.name}
          label={deleting.displayName}
          kind="policy"
          scope={scope}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
    </>
  )
}

type GuardrailConnectionListProps = {
  canCreate: boolean
  connections: GuardrailConnection[]
  scope: GuardrailActionScope
}

export function GuardrailConnectionList(props: GuardrailConnectionListProps) {
  "use no memo"
  const { canCreate, connections, scope } = props

  const [editing, setEditing] = useState<GuardrailConnection>()
  const [deleting, setDeleting] = useState<GuardrailConnection>()
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: connections,
    getCoreRowModel: getCoreRowModel(),
    columns: [
      connectionColumn.accessor("displayName", {
        header: "Name",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <GuardrailProviderIcon provider={row.original.provider} />
            <span className="min-w-0 truncate font-medium">{row.original.displayName}</span>
            {scope.workspaceId !== undefined && row.original.scope === "Organisation" ? (
              <Badge variant="secondary">Organization</Badge>
            ) : null}
          </div>
        ),
      }),
      connectionColumn.accessor("description", {
        header: "Description",
        cell: ({ getValue }) => (
          <span className="block truncate text-muted-foreground" title={getValue()}>
            {getValue() || "—"}
          </span>
        ),
      }),
      connectionColumn.accessor("provider", {
        header: "Service",
        cell: ({ row }) => guardrailProviderLabels[row.original.provider],
      }),
      connectionColumn.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => <GuardrailStatusBadge status={getValue()} />,
      }),
      connectionColumn.display({
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Actions for ${row.original.displayName}`}
                  className="size-8"
                  size="icon"
                  variant="ghost"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setEditing(row.original)}>
                    {row.original.canModify ? <Pencil /> : <Eye />}
                    {row.original.canModify ? "Edit" : "View"}
                  </DropdownMenuItem>
                  {row.original.canDelete ? (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleting(row.original)}
                    >
                      <Trash2 />
                      Delete
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      }),
    ],
  })
  return (
    <>
      <AdminDataGrid
        ariaLabel="Guardrail connections"
        emptyState={
          <AdministrationState
            kind={canCreate ? "welcome" : "empty"}
            title="No guardrail connections"
          />
        }
        layout={{
          displayName: { minWidth: 224, contentMaxWidth: 360 },
          description: { minWidth: 200, contentMaxWidth: 320, hiddenBelow: "lg" },
          provider: { minWidth: 192, width: 192 },
          status: { minWidth: 128, width: 128 },
          actions: { minWidth: 64, width: 64, align: "end" },
        }}
        onRowActivate={setEditing}
        rowAriaLabel={(connection) => `View ${connection.displayName}`}
        rows={connections}
        table={table}
      />
      {editing ? (
        <ConnectionSheet connection={editing} scope={scope} onClose={() => setEditing(undefined)} />
      ) : null}
      {deleting ? (
        <DeleteGuardrail
          name={deleting.name}
          label={deleting.displayName}
          kind="connection"
          scope={scope}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
    </>
  )
}

function GuardrailStatusBadge({ status }: { status: GuardrailStatus }) {
  const meta = statusMeta[status.state]
  const message = status.message.trim()
  const label = (
    <Badge tabIndex={message ? 0 : undefined} variant={meta.variant}>
      <meta.icon aria-hidden data-icon="inline-start" />
      {meta.label}
    </Badge>
  )
  if (!message) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  )
}

type DeleteGuardrailProps = {
  kind: "connection" | "policy"
  name: string
  label: string
  scope: GuardrailActionScope
  onClose: () => void
}

function DeleteGuardrail(props: DeleteGuardrailProps) {
  const { kind, name, label, scope, onClose } = props

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState("")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader className="min-w-0">
          <DialogTitle className="pr-6 leading-snug break-words">Delete {label}?</DialogTitle>
          <DialogDescription>
            Referenced {kind === "connection" ? "connections" : "policies"} cannot be deleted.
            Remove their assignments or references first. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not delete {kind}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button disabled={pending} onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <HoldToConfirm
            pending={pending}
            onConfirm={() =>
              startTransition(async () => {
                const result =
                  kind === "connection"
                    ? await deleteGuardrailConnectionAction(scope, name)
                    : await deleteGuardrailPolicyAction(scope, name)
                if (result.error) {
                  setError(result.error.message)
                  return
                }
                toast.success(`${kind === "connection" ? "Connection" : "Policy"} deleted`)
                router.refresh()
                onClose()
              })
            }
            type="button"
            variant="destructive"
          >
            <Trash2 data-icon="inline-start" />
            Hold to delete
          </HoldToConfirm>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GuardrailRolloutRefresh({ pending }: { pending: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (!pending) return
    const interval = window.setInterval(() => router.refresh(), 3000)
    return () => window.clearInterval(interval)
  }, [pending, router])
  return pending ? (
    <p className="px-4 text-sm text-muted-foreground md:px-6" role="status">
      Applying configuration. Status updates automatically.
    </p>
  ) : null
}

// Only the actions follow the child route; the header stays in the parent layout.
type GuardrailHeaderActionsProps = {
  connectionAction: ReactNode
  defaultSection: string
  policyAction: ReactNode
}

export function GuardrailHeaderActions(props: GuardrailHeaderActionsProps) {
  const { connectionAction, defaultSection, policyAction } = props

  const segments = useSelectedLayoutSegments()
  const view = segments[0] ?? defaultSection
  if (view === "connections") return connectionAction
  if (view === "policies") return policyAction
  return null
}
