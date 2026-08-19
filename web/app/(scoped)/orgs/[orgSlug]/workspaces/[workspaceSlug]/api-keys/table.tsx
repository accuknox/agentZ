"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { ColumnDef } from "@tanstack/react-table"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogAlert,
  DialogClose,
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
import { Spinner } from "@/components/ui/spinner"
import { EmptyValue, RelativeDateTime } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { UserAPIKey } from "@/data/api-key.queries"
import type { DeleteAPIKeyFormState } from "@/data/types"

const columnLayout = {
  name: { minWidth: 144 },
  workspace: { minWidth: 160, width: 160 },
  key: { minWidth: 128, width: 128 },
  targets: { contentMaxWidth: 288, minWidth: 208 },
  status: { minWidth: 96, width: 96 },
  expiresAt: { minWidth: 104, width: 104 },
  age: { minWidth: 96, width: 96 },
  actions: { align: "end", minWidth: 64, width: 64 },
} satisfies Record<string, AdminColumnLayout>

export function APIKeysTable({
  canDelete,
  deleteAPIKeyAction,
  keys,
}: {
  canDelete: boolean
  deleteAPIKeyAction: (
    state: DeleteAPIKeyFormState,
    formData: FormData
  ) => Promise<DeleteAPIKeyFormState>
  keys: UserAPIKey[]
}) {
  "use no memo"

  const columns = React.useMemo<ColumnDef<UserAPIKey>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="block truncate" title={row.original.name || undefined}>
            {row.original.name || <EmptyValue />}
          </span>
        ),
      },
      {
        id: "workspace",
        header: "Workspace",
        cell: ({ row }) => (
          <span className="block truncate" title={row.original.workspaceName}>
            {row.original.workspaceName}
          </span>
        ),
      },
      {
        id: "key",
        header: "Key",
        cell: ({ row }) => (
          <code>
            {row.original.prefix || "key_"}...{row.original.id.slice(-6)}
          </code>
        ),
      },
      {
        id: "targets",
        header: "Targets",
        cell: ({ row }) => <APIKeyTargets targets={row.original.targets} />,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <APIKeyStatus apiKey={row.original} />,
      },
      {
        id: "expiresAt",
        header: "Expires",
        cell: ({ row }) =>
          row.original.expiresAt ? (
            <RelativeDateTime value={row.original.expiresAt} />
          ) : (
            <EmptyValue />
          ),
      },
      {
        id: "age",
        header: "Age",
        cell: ({ row }) => <RelativeDateTime value={row.original.createdAt} />,
      },
      {
        id: "actions",
        cell: ({ row }) =>
          canDelete && !row.original.revokedAt ? (
            <DeleteAPIKeyButton deleteAPIKeyAction={deleteAPIKeyAction} keyID={row.original.id} />
          ) : null,
      },
    ],
    [canDelete, deleteAPIKeyAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ data: keys, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <AdminDataGrid
      ariaLabel="API keys"
      emptyState={
        <AdministrationState
          description="Create a key for selected Agents and workflow webhooks in this Workspace."
          kind="empty"
          title="No API keys"
        />
      }
      layout={columnLayout}
      rows={keys}
      table={table}
    />
  )
}

function APIKeyTargets({ targets }: { targets: UserAPIKey["targets"] }) {
  const workflowsByAgent = new Map<string, string[]>()
  const agentNames: string[] = []
  for (const target of targets) {
    if (target.targetType === "agent") {
      agentNames.push(target.agentName)
      continue
    }
    const workflowNames = workflowsByAgent.get(target.agentName) ?? []
    workflowNames.push(target.workflowName)
    workflowsByAgent.set(target.agentName, workflowNames)
  }

  const details = [
    ...agentNames.toSorted(),
    ...[...workflowsByAgent]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([agentName, workflowNames]) => `${agentName}: ${workflowNames.toSorted().join(", ")}`),
  ]
  const summary =
    details.length <= 2
      ? details.join(", ")
      : `${details.slice(0, 2).join(", ")}, +${details.length - 2}`

  if (!details.length) return <EmptyValue />

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="block max-w-72 cursor-default truncate">{summary}</code>
        </TooltipTrigger>
        <TooltipContent sideOffset={6} className="max-w-96 whitespace-pre-line">
          {details.join("\n")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function APIKeyStatus({ apiKey }: { apiKey: UserAPIKey }) {
  if (apiKey.revokedAt) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className="cursor-default" variant="destructive">
              Revoked
            </Badge>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>
            {apiKey.revokedReason ?? "Workspace access was revoked."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (!apiKey.enabled) {
    return <Badge variant="pending">Disabled</Badge>
  }
  if (apiKey.expired) {
    return <Badge variant="pending">Expired</Badge>
  }
  return <Badge variant="success">Active</Badge>
}

function DeleteAPIKeyButton({
  deleteAPIKeyAction,
  keyID,
}: {
  deleteAPIKeyAction: (
    state: DeleteAPIKeyFormState,
    formData: FormData
  ) => Promise<DeleteAPIKeyFormState>
  keyID: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [state, action, pending] = React.useActionState(deleteAPIKeyAction, {})
  const shown = open && !state.success

  React.useEffect(() => {
    if (!state.success) {
      return
    }
    toast.success("API key revoked")
    React.startTransition(() => router.refresh())
  }, [router, state.success])

  return (
    <>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open API key menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
                onSelect={(event) => {
                  event.preventDefault()
                  setOpen(true)
                }}
              >
                <Trash2 />
                Revoke
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={shown} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              Revoking this key immediately denies every request that uses it.
            </DialogDescription>
          </DialogHeader>
          {state.error ? (
            <DialogAlert variant="destructive">
              <AlertDescription>{state.error.message}</AlertDescription>
            </DialogAlert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input type="hidden" name="keyID" value={keyID} />
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? <Spinner aria-hidden="true" /> : <Trash2 data-icon="inline-start" />}
                Revoke
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
