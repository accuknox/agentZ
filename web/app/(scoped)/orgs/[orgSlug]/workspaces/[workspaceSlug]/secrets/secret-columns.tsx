"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Trash2 } from "lucide-react"
import type { SecretListItem, SecretState } from "@/lib/gateway/client"
import { formatAge } from "@/lib/format"
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DeleteSecretFormAction } from "@/data/types"

const secretStatusMeta = {
  accepted: {
    label: "Accepted",
    variant: "plain",
  },
  ready: {
    label: "Ready",
    variant: "successPlain",
  },
  degraded: {
    label: "Degraded",
    variant: "destructivePlain",
  },
} satisfies Record<
  SecretState,
  {
    label: string
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

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
      cell: ({ row }) => (
        <span className="block min-w-0 truncate font-mono text-sm" title={row.original.key}>
          {row.original.key}
        </span>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-sm whitespace-nowrap capitalize">{row.original.type}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <SecretStatusBadge secret={row.original} />,
    },
    {
      accessorKey: "hosts",
      header: "Hosts",
      cell: ({ row }) => {
        const hosts = row.original.hosts.join(" / ")

        return (
          <span
            className="text-muted-foreground block min-w-0 truncate font-mono text-xs"
            title={hosts}
          >
            {hosts}
          </span>
        )
      },
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
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{formatAge(row.original.created_at)}</span>
      ),
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

function SecretStatusBadge({ secret }: { secret: SecretListItem }) {
  const meta = secretStatusMeta[secret.status]
  const message = secret.message.trim()
  const badge = <Badge variant={meta.variant}>{meta.label}</Badge>

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
          <DropdownMenuItem variant="destructive" onSelect={() => setOpen(true)}>
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
