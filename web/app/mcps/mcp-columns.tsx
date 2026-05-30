"use client"

import * as React from "react"
import { dayjs } from "@/lib/dayjs"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import type { McpConnection } from "@/lib/gateway/client"
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
import { authModeOf } from "@/lib/mcp"
import type { DeleteMcpFormState, McpFormState } from "@/data/mcp.actions"
import { McpSheet } from "./mcp-sheet"

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
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
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
      cell: ({ row }) => {
        const state = row.original.status.state ?? "Accepted"
        const badgeVariant =
          state === "Ready"
            ? "success"
            : state === "Degraded"
              ? "destructive"
              : state === "NeedsAuth"
                ? "warning"
                : "pending"

        return <Badge variant={badgeVariant}>{state}</Badge>
      },
    },
    {
      id: "endpoint",
      header: "Endpoint",
      accessorFn: (row) => row.endpoint.url,
      cell: ({ row }) => (
        <span
          className="block min-w-0 truncate text-muted-foreground"
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
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
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
