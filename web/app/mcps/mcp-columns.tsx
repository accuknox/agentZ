"use client"

import * as React from "react"
import { dayjs } from "@/lib/dayjs"
import type { ColumnDef } from "@tanstack/react-table"
import {
  ArrowUpDown,
  CheckCircle2,
  CircleDashed,
  MoreHorizontal,
  Pencil,
  Trash2,
  XCircle,
} from "lucide-react"
import type {
  McpConnection,
  McpConnectionCondition,
  McpConnectionState,
} from "@/lib/gateway/client"
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
import { authModeOf } from "@/lib/mcp"
import type { DeleteMcpFormState, McpFormState } from "@/data/mcp.actions"
import { findMcpServerByURL, mcpFallbackIcon } from "./catalog"
import { McpSheet } from "./mcp-sheet"

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
  Degraded: {
    icon: XCircle,
    label: "Degraded",
    variant: "destructive",
  },
} satisfies Record<
  McpConnectionState,
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    label: string
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

export function createMcpColumns(actions: {
  submitMcpAction: (_: McpFormState, formData: FormData) => Promise<McpFormState>
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
}): ColumnDef<McpConnection>[] {
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
      header: "Auth mode",
      accessorFn: (row) => authModeOf(row),
      cell: ({ row }) => <span className="capitalize">{authModeOf(row.original)}</span>,
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (row) => row.status.state ?? "Accepted",
      cell: ({ row }) => <McpStatusBadge connection={row.original} />,
    },
    {
      id: "endpoint",
      header: "Endpoint",
      accessorFn: (row) => row.endpoint.url,
      cell: ({ row }) => (
        <span
          className="text-muted-foreground block min-w-0 truncate"
          title={row.original.endpoint.url}
        >
          {row.original.endpoint.url}
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
      cell: ({ row }) => <FormatAge value={row.original.created_at} />,
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <McpActions
          connection={row.original}
          submitMcpAction={actions.submitMcpAction}
          deleteMcpAction={actions.deleteMcpAction}
        />
      ),
    },
  ]
}

function McpNameCell({ connection }: { connection: McpConnection }) {
  const server = findMcpServerByURL(connection.endpoint.url)
  const Icon = server?.icon ?? mcpFallbackIcon

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{connection.name}</span>
    </div>
  )
}

function McpStatusBadge({ connection }: { connection: McpConnection }) {
  const state = connection.status.state ?? "Accepted"
  const meta = mcpStatusMeta[state]
  const conditionTypesByState = {
    Accepted: "Accepted",
    Ready: "Ready",
    Degraded: "Degraded",
  } satisfies Record<McpConnectionState, McpConnectionCondition["type"]>
  const matchingType = conditionTypesByState[state]
  const condition =
    connection.status.conditions.find((item) => item.type === matchingType) ??
    connection.status.conditions.find((item) => item.message.length > 0)
  const badge = (
    <Badge variant={meta.variant}>
      <meta.icon data-icon="inline-start" />
      {meta.label}
    </Badge>
  )

  if (condition === undefined || condition.message.length === 0) {
    return badge
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{condition.message}</TooltipContent>
    </Tooltip>
  )
}

function McpActions({
  connection,
  submitMcpAction,
  deleteMcpAction,
}: {
  connection: McpConnection
  submitMcpAction: (_: McpFormState, formData: FormData) => Promise<McpFormState>
  deleteMcpAction: (
    name: string,
    state: DeleteMcpFormState,
    formData: FormData
  ) => Promise<DeleteMcpFormState>
}) {
  const [editOpen, setEditOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <McpSheet
        mode="update"
        connection={connection}
        open={editOpen}
        onOpenChangeAction={setEditOpen}
        submitMcpAction={submitMcpAction}
      />
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
  connection: McpConnection
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

function FormatAge({ value }: { value: string }) {
  return <>{formatAge(value)}</>
}

function formatAge(value: string) {
  const d = dayjs(value)
  if (!d.isValid()) {
    return "Unknown"
  }
  return d.fromNow()
}
