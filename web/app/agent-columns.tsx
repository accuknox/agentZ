"use client"

import Link from "next/link"
import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal, Trash2 } from "lucide-react"
import type { ListAgent } from "@/lib/gateway/client"
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
import type { DeleteAgentFormState } from "@/data/types"

type DeleteAgentAction = (
  sessionID: string,
  state: DeleteAgentFormState,
  formData: FormData
) => Promise<DeleteAgentFormState>

export function createAgentColumns(deleteAgentAction: DeleteAgentAction): ColumnDef<ListAgent>[] {
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
        const agent = row.original

        return (
          <Link href={`/agent/${agent.session_id}`} className="font-medium hover:underline">
            {agent.name}
          </Link>
        )
      },
    },
    {
      accessorFn: (agent) => agent.configuration.model.primary.name,
      id: "primaryModel",
      header: "Primary Model",
    },
    {
      accessorFn: (agent) => agent.configuration.model.primary.contextWindow,
      id: "contextWindow",
      header: "Context Window",
      cell: ({ row }) => {
        const contextWindow = row.getValue<number>("contextWindow")

        return formatNumber(contextWindow)
      },
    },
    {
      accessorFn: (agent) => agent.configuration.model.summary?.name ?? "Unknown",
      id: "summaryModel",
      header: "Summary Model",
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
        const agent = row.original

        return <AgentActions agent={agent} deleteAgentAction={deleteAgentAction} />
      },
    },
  ]
}

function AgentActions({
  agent,
  deleteAgentAction,
}: {
  agent: ListAgent
  deleteAgentAction: DeleteAgentAction
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className="text-right">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/agent/${agent.session_id}`}>Chat</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/agent/update/${agent.session_id}`}>Edit</Link>
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => setOpen(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAgentDialog
        agent={agent}
        deleteAgentAction={deleteAgentAction}
        open={open}
        setOpen={setOpen}
      />
    </div>
  )
}

function DeleteAgentDialog({
  agent,
  deleteAgentAction,
  open,
  setOpen,
}: {
  agent: ListAgent
  deleteAgentAction: DeleteAgentAction
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteAgentAction.bind(null, agent.session_id),
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
          <DialogTitle>Delete {agent.name}?</DialogTitle>
          <DialogDescription>
            This will delete the agent permanently. This action cannot be undone.
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

function formatNumber(value?: number) {
  if (value === undefined) {
    return "Unknown"
  }

  return new Intl.NumberFormat("en").format(value)
}
