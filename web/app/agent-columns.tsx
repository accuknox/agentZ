"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import Link from "next/link"
import type { Route } from "next"
import { ArrowUpDown, MoreHorizontal, Pencil, Settings, Trash2 } from "lucide-react"
import type { Agent, Sandbox, Skill } from "@/lib/gateway/client"
import { AgentDialog } from "@/app/agent/agent-dialog"
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
import type { AgentActionScope } from "@/data/agent.actions"
import type { DeleteAgentFormState } from "@/data/types"
import { formatAge } from "@/lib/format"

type DeleteAgentAction = (
  agentName: string,
  state: DeleteAgentFormState,
  formData: FormData
) => Promise<DeleteAgentFormState>

export function createAgentColumns(
  deleteAgentAction: DeleteAgentAction,
  immutableSkills: Skill[],
  sandboxes: Sandbox[],
  initialHasNextSandboxPage: boolean,
  initialNextSandboxPageToken: string,
  actionScope: AgentActionScope
): ColumnDef<Agent>[] {
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

        return <span className="font-medium">{agent.name}</span>
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
      cell: ({ row }) => formatAge(row.getValue("created_at")),
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const agent = row.original

        return (
          <AgentActions
            agent={agent}
            deleteAgentAction={deleteAgentAction}
            immutableSkills={immutableSkills}
            sandboxes={sandboxes}
            initialHasNextSandboxPage={initialHasNextSandboxPage}
            initialNextSandboxPageToken={initialNextSandboxPageToken}
            actionScope={actionScope}
          />
        )
      },
    },
  ]
}

function AgentActions({
  agent,
  deleteAgentAction,
  immutableSkills,
  sandboxes,
  initialHasNextSandboxPage,
  initialNextSandboxPageToken,
  actionScope,
}: {
  agent: Agent
  deleteAgentAction: DeleteAgentAction
  immutableSkills: Skill[]
  sandboxes: Sandbox[]
  initialHasNextSandboxPage: boolean
  initialNextSandboxPageToken: string
  actionScope: AgentActionScope
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)

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
            <Link href={`${actionScope.basePath}/${agent.name}` as Route}>
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setEditOpen(true)
            }}
          >
            <Pencil />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AgentDialog
        mode="update"
        actionScope={actionScope}
        agentName={agent.name}
        initialSandboxName={agent.sandbox.name}
        initialMemoryEnabled={agent.memory.enabled}
        initialSkills={agent.skills.map((skill) => skill.name)}
        immutableSkills={immutableSkills}
        sandboxes={sandboxes}
        initialHasNextSandboxPage={initialHasNextSandboxPage}
        initialNextSandboxPageToken={initialNextSandboxPageToken}
        open={editOpen}
        onOpenChangeAction={setEditOpen}
      />
      <DeleteAgentDialog
        agent={agent}
        deleteAgentAction={deleteAgentAction}
        open={deleteOpen}
        setOpen={setDeleteOpen}
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
  agent: Agent
  deleteAgentAction: DeleteAgentAction
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteAgentAction.bind(null, agent.name),
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
