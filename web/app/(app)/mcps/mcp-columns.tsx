"use client"

import * as React from "react"
import { formatAge } from "@/lib/format"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ArrowUpDown,
  CheckCircle2,
  CircleDashed,
  Eye,
  MoreHorizontal,
  Trash2,
  XCircle,
} from "lucide-react"
import type { McpConnectionLifecycle, McpConnectionSummary } from "@/lib/gateway/client"
import { Badge } from "@/components/ui/badge"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DeleteMcpFormState } from "@/data/mcp.actions"
import { renderMcpServerIcon } from "./catalog"

const mcpStatusMeta = {
  Accepted: {
    icon: CircleDashed,
    label: "Accepted",
    variant: "pending",
  },
  Ready: {
    icon: CheckCircle2,
    label: "Ready",
    variant: "success",
  },
  Error: {
    icon: XCircle,
    label: "Error",
    variant: "destructive",
  },
} satisfies Record<
  McpConnectionLifecycle,
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    label: string
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

export function createMcpColumns(actions: {
  onViewAction: (connection: McpConnectionSummary) => void
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
}): ColumnDef<McpConnectionSummary>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <McpNameCell connection={row.original} />,
    },
    {
      id: "auth_mode",
      header: "Auth type",
      accessorFn: (row) => row.auth_mode.toLowerCase(),
      cell: ({ row }) => <span className="capitalize">{row.original.auth_mode.toLowerCase()}</span>,
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (row) => row.status,
      cell: ({ row }) => <McpStatusBadge connection={row.original} />,
    },
    {
      id: "endpoint",
      header: "Endpoint",
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
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Age
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <span>{formatAge(row.original.created_at)}</span>,
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <McpActions
          connection={row.original}
          deleteMcpAction={actions.deleteMcpAction}
          onViewAction={actions.onViewAction}
        />
      ),
    },
  ]
}

function McpNameCell({ connection }: { connection: McpConnectionSummary }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {renderMcpServerIcon(connection.endpoint_url, {
        "aria-hidden": "true",
        className: "size-4 shrink-0",
      })}
      <span className="min-w-0 truncate font-medium">{connection.name}</span>
    </div>
  )
}

function McpStatusBadge({ connection }: { connection: McpConnectionSummary }) {
  const state = connection.status
  const meta = mcpStatusMeta[state]
  const message = connection.message.trim()
  const badge = (
    <Badge variant={meta.variant}>
      <meta.icon data-icon="inline-start" />
      {meta.label}
    </Badge>
  )

  if (!message) {
    return badge
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  )
}

function McpActions({
  connection,
  deleteMcpAction,
  onViewAction,
}: {
  connection: McpConnectionSummary
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
  onViewAction: (connection: McpConnectionSummary) => void
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  return (
    <div
      className="flex justify-end"
      onClick={(event) => {
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => {
                onViewAction(connection)
              }}
            >
              <Eye />
              View
            </DropdownMenuItem>
            {connection.can_delete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteMcpDialog
        connection={connection}
        deleteMcpAction={deleteMcpAction}
        open={deleteOpen}
        setOpen={setDeleteOpen}
      />
    </div>
  )
}

function DeleteMcpDialog({
  connection,
  deleteMcpAction,
  open,
  setOpen,
}: {
  connection: McpConnectionSummary
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteMcpAction.bind(null, connection.name),
    {}
  )

  React.useEffect(() => {
    if (!pending && !state.error) {
      setOpen(false)
    }
  }, [pending, setOpen, state.error])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {connection.name}?</DialogTitle>
          <DialogDescription>
            This will delete the MCP connection and its stored credentials.
          </DialogDescription>
        </DialogHeader>
        {state.error ? (
          <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
            {state.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <form action={action}>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Spinner /> : <Trash2 />}
              Delete
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
