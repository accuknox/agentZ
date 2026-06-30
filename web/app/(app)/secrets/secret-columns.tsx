"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Trash2 } from "lucide-react"
import type { SecretListItem } from "@/lib/gateway/client"
import { dayjs } from "@/lib/dayjs"
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import type { DeleteSecretFormAction } from "@/data/types"

export function createSecretColumns(
  agentName: string,
  deleteSecretAction: DeleteSecretFormAction
): ColumnDef<SecretListItem>[] {
  return [
    {
      accessorKey: "key",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Key
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.key}</span>,
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => <span className="text-sm capitalize">{row.original.type}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <span className="text-sm capitalize">{row.original.status}</span>,
    },
    {
      accessorKey: "hosts",
      header: "Hosts",
      cell: ({ row }) => (
        <div className="flex max-w-120 flex-wrap gap-x-2 gap-y-0.5 text-xs">
          {row.original.hosts.map((host, index) => (
            <span key={host} className="text-muted-foreground font-mono">
              {index > 0 ? <span className="text-border mr-2">/</span> : null}
              {host}
            </span>
          ))}
        </div>
      ),
    },
    {
      accessorKey: "modified_at",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Updated
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => formatDate(row.original.modified_at),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <SecretActions
          agentName={agentName}
          item={row.original}
          deleteSecretAction={deleteSecretAction}
        />
      ),
    },
  ]
}

function SecretActions({
  agentName,
  item,
  deleteSecretAction,
}: {
  agentName: string
  item: SecretListItem
  deleteSecretAction: DeleteSecretFormAction
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open secret menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="text-destructive" onSelect={() => setOpen(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteSecretDialog
        agentName={agentName}
        item={item}
        deleteSecretAction={deleteSecretAction}
        open={open}
        setOpen={setOpen}
      />
    </div>
  )
}

function DeleteSecretDialog({
  agentName,
  item,
  deleteSecretAction,
  open,
  setOpen,
}: {
  agentName: string
  item: SecretListItem
  deleteSecretAction: DeleteSecretFormAction
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const [state, action, pending] = React.useActionState(
    deleteSecretAction.bind(null, agentName),
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
          <DialogTitle>Delete {item.key}?</DialogTitle>
          <DialogDescription>This will remove the secret permanently.</DialogDescription>
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
            <input type="hidden" name="key" value={item.key} readOnly />
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

function formatDate(value?: string) {
  if (!value) {
    return "Unknown"
  }
  const date = dayjs(value)
  if (!date.isValid()) {
    return "Unknown"
  }
  return `${date.format("MMM D, YYYY, h:mm A")} (${date.fromNow()})`
}
