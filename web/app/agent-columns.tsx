"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import Link from "next/link"
import { MoreHorizontal, Pencil, Settings, Trash2 } from "lucide-react"
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
import { UserAvatar } from "@/components/ui/avatar"
import { toast } from "sonner"
import { RelativeDateTime } from "@/components/ui/table"
import type { AgentActionScope } from "@/data/agent.actions"
import type { DeleteAgentFormState } from "@/data/types"

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
  actionScope: AgentActionScope,
  showActions: boolean
): ColumnDef<Agent>[] {
  const columns: ColumnDef<Agent>[] = [
    {
      accessorKey: "name",
      enableSorting: true,
      header: "Name",
      cell: ({ row }) => {
        const agent = row.original

        return <span className="font-medium">{agent.name}</span>
      },
    },
    {
      accessorKey: "created_by",
      header: "Created by",
      cell: ({ row }) => <UserAvatar {...row.original.created_by} />,
    },
    {
      accessorKey: "last_modified_by",
      header: "Modified by",
      cell: ({ row }) => <UserAvatar {...row.original.last_modified_by} />,
    },
    {
      accessorKey: "created_at",
      enableSorting: true,
      header: "Created at",
      cell: ({ row }) => <RelativeDateTime value={row.getValue("created_at")} />,
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
  if (!showActions) columns.pop()
  return columns
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
            <Link href={`${actionScope.workspacePath}/agents/${encodeURIComponent(agent.name)}`}>
              <Settings />
              Settings
            </Link>
          </DropdownMenuItem>
          {agent.capabilities.modify ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setEditOpen(true)
              }}
            >
              <Pencil />
              Edit
            </DropdownMenuItem>
          ) : null}
          {agent.capabilities.delete ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {agent.capabilities.modify ? (
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
      ) : null}
      {agent.capabilities.delete ? (
        <DeleteAgentDialog
          agent={agent}
          deleteAgentAction={deleteAgentAction}
          open={deleteOpen}
          setOpen={setDeleteOpen}
        />
      ) : null}
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
    if (state.success) {
      toast.success("Agent deleted")
      setOpen(false)
    }
  }, [setOpen, state.success])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {agent.name}?</DialogTitle>
          <DialogDescription>
            Deleting this Agent removes it permanently. You cannot undo this action.
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
