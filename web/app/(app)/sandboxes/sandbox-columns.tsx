"use client"

import Link from "next/link"
import type { Route } from "next"
import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import type { Sandbox } from "@/lib/gateway/client"
import { Badge } from "@/components/ui/badge"
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
import { toast } from "sonner"
import type { DeleteSandboxFormState } from "@/data/types"
import { TableRelativeTime } from "@/components/ui/table"

type DeleteSandboxAction = (
  name: string,
  state: DeleteSandboxFormState,
  formData: FormData
) => Promise<DeleteSandboxFormState>

export function createSandboxColumns(
  basePath: string,
  deleteSandboxAction: DeleteSandboxAction,
  showOrganisation: boolean
): ColumnDef<Sandbox>[] {
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
        const sandbox = row.original

        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium">{sandbox.name}</span>
            {showOrganisation && sandbox.scope === "Organisation" ? (
              <Badge variant="secondary">Organisation</Badge>
            ) : null}
          </div>
        )
      },
    },
    {
      accessorFn: (sandbox) => sandbox.metadata.package_count,
      id: "packages",
      header: "Packages",
      cell: ({ row }) => {
        const count = row.getValue<number>("packages")
        return `${count} package${count === 1 ? "" : "s"}`
      },
    },
    {
      accessorFn: (sandbox) => sandbox.metadata.allowed_host_count,
      id: "allowed_hosts",
      header: "Allowed hosts",
      cell: ({ row }) => {
        const count = row.getValue<number>("allowed_hosts")
        return `${count} host${count === 1 ? "" : "s"}`
      },
    },
    {
      accessorFn: (sandbox) => sandbox.inference.models.length,
      id: "models",
      header: "Models / Pools",
    },
    {
      accessorFn: (sandbox) => sandbox.mcp_connection_refs.length,
      id: "mcps",
      header: "MCP",
      cell: ({ row }) => {
        const count = row.getValue<number>("mcps")
        return `${count} MCP${count === 1 ? "" : "s"}`
      },
    },
    {
      accessorFn: (sandbox) => sandbox.metadata.skill_count,
      id: "skills",
      header: "Skills",
      cell: ({ row }) => {
        const count = row.getValue<number>("skills")
        return `${count} skill${count === 1 ? "" : "s"}`
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
      cell: ({ row }) => <TableRelativeTime value={row.getValue("created_at")} />,
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const sandbox = row.original

        return (
          <SandboxActions
            basePath={basePath}
            sandbox={sandbox}
            deleteSandboxAction={deleteSandboxAction}
          />
        )
      },
    },
  ]
}

function SandboxActions({
  sandbox,
  basePath,
  deleteSandboxAction,
}: {
  sandbox: Sandbox
  basePath: string
  deleteSandboxAction: DeleteSandboxAction
}) {
  const [open, setOpen] = React.useState(false)
  const referenced = sandbox.metadata.referenced_by_agent

  return (
    <div
      className="flex justify-end"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {sandbox.can_modify || sandbox.can_delete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sandbox.can_modify ? (
              <DropdownMenuItem asChild>
                <Link href={`${basePath}/update/${sandbox.name}` as Route}>
                  <Pencil />
                  Edit
                </Link>
              </DropdownMenuItem>
            ) : null}
            {sandbox.can_delete ? (
              <DropdownMenuItem
                variant="destructive"
                disabled={referenced}
                onSelect={() => setOpen(true)}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DeleteSandboxDialog
        sandbox={sandbox}
        deleteSandboxAction={deleteSandboxAction}
        open={open}
        setOpen={setOpen}
      />
    </div>
  )
}

function DeleteSandboxDialog({
  sandbox,
  deleteSandboxAction,
  open,
  setOpen,
}: {
  sandbox: Sandbox
  deleteSandboxAction: DeleteSandboxAction
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteSandboxAction.bind(null, sandbox.name),
    {}
  )

  React.useEffect(() => {
    if (state.success) {
      toast.success("Sandbox deleted")
      setOpen(false)
    }
  }, [setOpen, state.success])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {sandbox.name}?</DialogTitle>
          <DialogDescription>
            This will delete the sandbox permanently. This action cannot be undone.
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
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || sandbox.metadata.referenced_by_agent}
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
