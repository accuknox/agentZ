"use client"

import * as React from "react"
import type { Route } from "next"
import { toast } from "sonner"
import { useRouter } from "@bprogress/next/app"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react"
import type { WorkflowSchedule, WorkflowSummary } from "@/lib/gateway/client"
import { TokenTablePagination } from "@/components/table-pagination"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
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
import { RelativeDateTime } from "@/components/ui/table"
import type {
  DeleteWorkflowScheduleFormState,
  UpdateWorkflowScheduleFormState,
  WorkflowInputContractResult,
} from "@/data/types"
import type { TriggerWorkflowRunActionState } from "@/data/workflow-run.actions"
import { ScheduleSheet } from "./schedule-sheet"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 192, contentMaxWidth: 288, pin: "start" },
  workflow_name: { minWidth: 192, contentMaxWidth: 288 },
  schedule: { minWidth: 192, contentMaxWidth: 288 },
  created_at: { minWidth: 144, width: 144 },
  actions: { minWidth: 64, width: 64, pin: "end" },
}

export function ScheduleTriggersTable({
  agentName,
  basePath,
  workflows,
  workflowSchedules,
  hasNextPage,
  nextPageToken,
  deleteWorkflowScheduleAction,
  getWorkflowInputContractAction,
  triggerWorkflowRunAction,
  updateWorkflowScheduleAction,
}: {
  agentName: string
  basePath: string
  workflows: WorkflowSummary[]
  workflowSchedules: WorkflowSchedule[]
  hasNextPage: boolean
  nextPageToken: string
  deleteWorkflowScheduleAction: (
    agentName: string,
    state: DeleteWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<DeleteWorkflowScheduleFormState>
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>
  triggerWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    scheduleName: string,
    state: TriggerWorkflowRunActionState,
    formData: FormData
  ) => Promise<TriggerWorkflowRunActionState>
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
}) {
  "use no memo"

  const columns = React.useMemo<ColumnDef<WorkflowSchedule>[]>(
    () =>
      createColumns(
        agentName,
        workflows,
        deleteWorkflowScheduleAction,
        getWorkflowInputContractAction,
        triggerWorkflowRunAction,
        updateWorkflowScheduleAction
      ),
    [
      agentName,
      deleteWorkflowScheduleAction,
      getWorkflowInputContractAction,
      triggerWorkflowRunAction,
      updateWorkflowScheduleAction,
      workflows,
    ]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: workflowSchedules,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <AdminDataGrid
      ariaLabel="Workflow schedules"
      emptyState={<p className="text-muted-foreground py-8 text-center">No schedules found.</p>}
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(schedule) =>
        `${basePath}/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=schedule&workflow_name=${encodeURIComponent(schedule.workflow_name)}&schedule_name=${encodeURIComponent(schedule.name)}` as Route
      }
      rows={workflowSchedules}
      table={table}
    />
  )
}

function createColumns(
  agentName: string,
  workflows: WorkflowSummary[],
  deleteWorkflowScheduleAction: (
    agentName: string,
    state: DeleteWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<DeleteWorkflowScheduleFormState>,
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>,
  triggerWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    scheduleName: string,
    state: TriggerWorkflowRunActionState,
    formData: FormData
  ) => Promise<TriggerWorkflowRunActionState>,
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
): ColumnDef<WorkflowSchedule>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "workflow_name",
      header: "Workflow",
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.workflow_name}</span>,
    },
    {
      accessorKey: "schedule",
      header: "Schedule",
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.schedule}</span>,
    },
    {
      accessorKey: "created_at",
      header: "Age",
      cell: ({ row }) => <RelativeDateTime value={row.original.created_at} />,
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <ScheduleActions
          agentName={agentName}
          workflows={workflows}
          item={row.original}
          deleteWorkflowScheduleAction={deleteWorkflowScheduleAction}
          getWorkflowInputContractAction={getWorkflowInputContractAction}
          triggerWorkflowRunAction={triggerWorkflowRunAction}
          updateWorkflowScheduleAction={updateWorkflowScheduleAction}
        />
      ),
    },
  ]
}

function ScheduleActions({
  agentName,
  workflows,
  item,
  deleteWorkflowScheduleAction,
  getWorkflowInputContractAction,
  triggerWorkflowRunAction,
  updateWorkflowScheduleAction,
}: {
  agentName: string
  workflows: WorkflowSummary[]
  item: WorkflowSchedule
  deleteWorkflowScheduleAction: (
    agentName: string,
    state: DeleteWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<DeleteWorkflowScheduleFormState>
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>
  triggerWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    scheduleName: string,
    state: TriggerWorkflowRunActionState,
    formData: FormData
  ) => Promise<TriggerWorkflowRunActionState>
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
}) {
  const [editOpen, setEditOpen] = React.useState(false)
  const [runOpen, setRunOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  return (
    <div
      className="flex justify-end"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRunOpen(true)}>
            <Play />
            Run
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ScheduleSheet
        agentName={agentName}
        mode="update"
        workflows={workflows}
        scheduleItem={item}
        putWorkflowScheduleAction={updateWorkflowScheduleAction}
        getWorkflowInputContractAction={getWorkflowInputContractAction}
        open={editOpen}
        onOpenChangeAction={setEditOpen}
      />
      <RunScheduleDialog
        agentName={agentName}
        item={item}
        open={runOpen}
        setOpen={setRunOpen}
        triggerWorkflowRunAction={triggerWorkflowRunAction}
      />
      <DeleteScheduleDialog
        agentName={agentName}
        item={item}
        deleteWorkflowScheduleAction={deleteWorkflowScheduleAction}
        open={deleteOpen}
        setOpen={setDeleteOpen}
      />
    </div>
  )
}

function RunScheduleDialog({
  agentName,
  item,
  open,
  setOpen,
  triggerWorkflowRunAction,
}: {
  agentName: string
  item: WorkflowSchedule
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  triggerWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    scheduleName: string,
    state: TriggerWorkflowRunActionState,
    formData: FormData
  ) => Promise<TriggerWorkflowRunActionState>
}) {
  const router = useRouter()
  const [state, action, pending] = React.useActionState(
    async (state: TriggerWorkflowRunActionState, formData: FormData) => {
      const result = await triggerWorkflowRunAction(
        agentName,
        item.workflow_name,
        item.name,
        state,
        formData
      )
      if (result.href) {
        toast.success("Workflow started")
        router.push(result.href)
      }
      return result
    },
    { success: false }
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run {item.name} now?</DialogTitle>
          <DialogDescription>
            This will trigger the workflow schedule immediately using its saved configuration.
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
            <input type="hidden" name="workflow_name" value={item.workflow_name} />
            <input type="hidden" name="schedule_name" value={item.name} />
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner /> : <Play />}
              Run
            </Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteScheduleDialog({
  agentName,
  item,
  deleteWorkflowScheduleAction,
  open,
  setOpen,
}: {
  agentName: string
  item: WorkflowSchedule
  deleteWorkflowScheduleAction: (
    agentName: string,
    state: DeleteWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<DeleteWorkflowScheduleFormState>
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [state, action, pending] = React.useActionState(
    deleteWorkflowScheduleAction.bind(null, agentName),
    {}
  )

  React.useEffect(() => {
    if (state.success) {
      toast.success("Schedule deleted")
      setOpen(false)
    }
  }, [setOpen, state.success])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {item.name}?</DialogTitle>
          <DialogDescription>
            This will delete the workflow schedule permanently. This action cannot be undone.
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
            <input type="hidden" name="name" value={item.name} />
            <input type="hidden" name="workflow_name" value={item.workflow_name} />
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
