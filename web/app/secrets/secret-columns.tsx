"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import type { SecretListItem } from "@/lib/gateway/client"
import { dayjs } from "@/lib/dayjs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { DeleteSecretFormState, PutSecretFormState } from "@/data/types"
import { SecretSheet } from "./secret-sheet"

type DeleteSecretAction = (
  sessionID: string,
  state: DeleteSecretFormState,
  formData: FormData
) => Promise<DeleteSecretFormState>

type PutSecretAction = (
  sessionID: string,
  state: PutSecretFormState,
  formData: FormData
) => Promise<PutSecretFormState>

export function createSecretColumns(
  sessionID: string,
  deleteSecretAction: DeleteSecretAction,
  putSecretAction: PutSecretAction
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
      accessorKey: "created_at",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => formatDate(row.original.created_at),
    },
    {
      accessorKey: "modified_at",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Modified
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => formatDate(row.original.modified_at),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const item = row.original

        return (
          <SecretActions
            sessionID={sessionID}
            item={item}
            deleteSecretAction={deleteSecretAction}
            putSecretAction={putSecretAction}
          />
        )
      },
    },
  ]
}

function SecretActions({
  sessionID,
  item,
  deleteSecretAction,
  putSecretAction,
}: {
  sessionID: string
  item: SecretListItem
  deleteSecretAction: DeleteSecretAction
  putSecretAction: PutSecretAction
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
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SecretSheet
        sessionID={sessionID}
        mode="update"
        secretKey={item.key}
        putSecretAction={putSecretAction}
        open={editOpen}
        onOpenChangeAction={setEditOpen}
      />
      <DeleteSecretDialog
        sessionID={sessionID}
        item={item}
        deleteSecretAction={deleteSecretAction}
        open={deleteOpen}
        setOpen={setDeleteOpen}
      />
    </div>
  )
}

function DeleteSecretDialog({
  sessionID,
  item,
  deleteSecretAction,
  open,
  setOpen,
}: {
  sessionID: string
  item: SecretListItem
  deleteSecretAction: DeleteSecretAction
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteSecretAction.bind(null, sessionID),
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
          <DialogDescription>
            This will delete the secret permanently. This action cannot be undone.
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
            <input type="hidden" name="key" value={item.key} />
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

  const d = dayjs(value)
  if (!d.isValid()) {
    return "Unknown"
  }

  const formatted = d.format("MMM D, YYYY, h:mm A")
  const relative = d.fromNow()

  return `${formatted} (${relative})`
}
