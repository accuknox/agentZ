"use client"

import Link from "next/link"
import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Trash2 } from "lucide-react"
import type { Environment } from "@/lib/gateway/client"
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
import type { DeleteEnvironmentFormState } from "@/data/types"

type DeleteEnvironmentAction = (
  name: string,
  state: DeleteEnvironmentFormState,
  formData: FormData
) => Promise<DeleteEnvironmentFormState>

export function createEnvironmentColumns(
  deleteEnvironmentAction: DeleteEnvironmentAction
): ColumnDef<Environment>[] {
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
      cell: ({ row }) => {
        const env = row.original

        return (
          <Link href={`/environments/update/${env.name}`} className="font-medium hover:underline">
            {env.name}
          </Link>
        )
      },
    },
    {
      accessorFn: (env) => env.metadata.package_count,
      id: "packages",
      header: "Packages",
      cell: ({ row }) => {
        const count = row.getValue<number>("packages")
        return `${count} package${count === 1 ? "" : "s"}`
      },
    },
    {
      accessorFn: (env) => env.metadata.allowed_host_count,
      id: "allowed_hosts",
      header: "Allowed hosts",
      cell: ({ row }) => {
        const count = row.getValue<number>("allowed_hosts")
        return `${count} host${count === 1 ? "" : "s"}`
      },
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
      cell: ({ row }) => formatDate(row.getValue("created_at")),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const env = row.original

        return <EnvironmentActions env={env} deleteEnvironmentAction={deleteEnvironmentAction} />
      },
    },
  ]
}

function EnvironmentActions({
  env,
  deleteEnvironmentAction,
}: {
  env: Environment
  deleteEnvironmentAction: DeleteEnvironmentAction
}) {
  const [open, setOpen] = React.useState(false)
  const referenced = env.metadata.referenced_by_agent

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
          <DropdownMenuItem asChild>
            <Link href={`/environments/update/${env.name}`}>Edit</Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            disabled={referenced}
            onSelect={() => setOpen(true)}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteEnvironmentDialog
        env={env}
        deleteEnvironmentAction={deleteEnvironmentAction}
        open={open}
        setOpen={setOpen}
      />
    </div>
  )
}

function DeleteEnvironmentDialog({
  env,
  deleteEnvironmentAction,
  open,
  setOpen,
}: {
  env: Environment
  deleteEnvironmentAction: DeleteEnvironmentAction
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteEnvironmentAction.bind(null, env.name),
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
          <DialogTitle>Delete {env.name}?</DialogTitle>
          <DialogDescription>
            This will delete the environment permanently. This action cannot be undone.
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
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || env.metadata.referenced_by_agent}
            >
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

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
