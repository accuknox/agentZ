"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowLeft, ArrowRight, ArrowUpDown, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import type { WorkflowSchedule, WorkflowSummary } from "@/lib/gateway/client"
import { dayjs } from "@/lib/dayjs"
import { useTokenPagination } from "@/app/lens/traces/client-utils"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  DeleteWorkflowScheduleFormState,
  UpdateWorkflowScheduleFormState,
  WorkflowInputSchemaResult,
} from "@/data/types"
import { ScheduleSheet } from "./schedule-sheet"

const columnClassName: Record<string, string> = {
  name: "min-w-48",
  workflow_name: "min-w-48",
  schedule: "min-w-48",
  created_at: "w-36",
  actions: "w-14",
}

export function SchedulesTable({
  agentName,
  workflows,
  workflowSchedules,
  hasNextPage,
  nextPageToken,
  deleteWorkflowScheduleAction,
  getWorkflowInputSchemaAction,
  updateWorkflowScheduleAction,
}: {
  agentName: string
  workflows: WorkflowSummary[]
  workflowSchedules: WorkflowSchedule[]
  hasNextPage: boolean
  nextPageToken: string
  deleteWorkflowScheduleAction: (
    agentName: string,
    state: DeleteWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<DeleteWorkflowScheduleFormState>
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([{ id: "created_at", desc: true }])
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()
  const columns = React.useMemo<ColumnDef<WorkflowSchedule>[]>(
    () =>
      createColumns(
        agentName,
        workflows,
        deleteWorkflowScheduleAction,
        getWorkflowInputSchemaAction,
        updateWorkflowScheduleAction
      ),
    [
      agentName,
      deleteWorkflowScheduleAction,
      getWorkflowInputSchemaAction,
      updateWorkflowScheduleAction,
      workflows,
    ]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: workflowSchedules,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  })

  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 w-full overflow-hidden border-b">
        <Table className="table-auto">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={`h-8 px-4 ${columnClassName[header.column.id] ?? ""}`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`h-11 px-4 py-1.5 ${columnClassName[cell.column.id] ?? ""}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No workflow schedules
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 px-2">
        <Button variant="ghost" size="sm" onClick={goPrevious} disabled={!canGoPrevious || pending}>
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goNext(nextPageToken)}
          disabled={!hasNextPage || pending}
        >
          Next
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
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
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>,
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
): ColumnDef<WorkflowSchedule>[] {
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
      accessorKey: "workflow_name",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Workflow
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.workflow_name}</span>,
    },
    {
      accessorKey: "schedule",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Schedule
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.schedule}</span>,
    },
    {
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
      sortingFn: "datetime",
      cell: ({ row }) => {
        const createdAt = dayjs(row.original.created_at)
        if (!createdAt.isValid()) {
          return "Unknown"
        }

        return createdAt.fromNow()
      },
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <ScheduleActions
          agentName={agentName}
          workflows={workflows}
          item={row.original}
          deleteWorkflowScheduleAction={deleteWorkflowScheduleAction}
          getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
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
  getWorkflowInputSchemaAction,
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
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>
  updateWorkflowScheduleAction: (
    agentName: string,
    state: UpdateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<UpdateWorkflowScheduleFormState>
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
      <ScheduleSheet
        agentName={agentName}
        mode="update"
        workflows={workflows}
        scheduleItem={item}
        putWorkflowScheduleAction={updateWorkflowScheduleAction}
        getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
        open={editOpen}
        onOpenChangeAction={setEditOpen}
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
    if (!pending && !state.error) {
      setOpen(false)
    }
  }, [pending, setOpen, state.error])

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
            <input type="hidden" name="name" value={item.name} />
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
