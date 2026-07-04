"use client"

import * as React from "react"
import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  MoreHorizontal,
  Trash2,
  XCircle,
} from "lucide-react"
import { dayjs } from "@/lib/dayjs"
import {
  getWorkflowRun,
  watchWorkflowRuns,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WatchWorkflowRunsResponse,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { useTokenPagination } from "@/app/(app)/lens/traces/client-utils"
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DeleteWorkflowRunActionState } from "@/data/workflow-run.actions"

const columnClassName: Record<string, string> = {
  name: "min-w-56",
  workflow_name: "min-w-44",
  status: "w-40",
  duration_seconds: "w-28",
  created_at: "w-36",
  actions: "w-14",
}

const runStatusMeta = {
  Pending: {
    icon: CircleDashed,
    label: "Pending",
    variant: "pending",
  },
  Running: {
    icon: Spinner,
    label: "Running",
    variant: "running",
  },
  Succeeded: {
    icon: CheckCircle2,
    label: "Succeeded",
    variant: "success",
  },
  Failed: {
    icon: XCircle,
    label: "Failed",
    variant: "destructive",
  },
  Unacked: {
    icon: CircleAlert,
    label: "Unacked",
    variant: "warning",
  },
} satisfies Record<
  WorkflowRunStatus,
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    label: string
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

export function RunsTable({
  agentName,
  workflowName,
  workflowRuns,
  hasNextPage,
  nextPageToken,
  deleteWorkflowRunAction,
}: {
  agentName: string
  workflowName: string
  workflowRuns: WorkflowRunSummary[]
  hasNextPage: boolean
  nextPageToken: string
  deleteWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    state: DeleteWorkflowRunActionState,
    formData: FormData
  ) => Promise<DeleteWorkflowRunActionState>
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([{ id: "created_at", desc: true }])
  const query = useQuery(
    queryOptions({
      enabled: workflowRuns.length > 0,
      placeholderData: workflowRuns,
      queryFn: streamedQuery<
        WatchWorkflowRunsResponse,
        WorkflowRunSummary[],
        readonly ["watchWorkflowRuns", string, string, string[]]
      >({
        initialValue: workflowRuns,
        reducer: (rows, event) => {
          const byName = new Map(rows.map((row) => [row.name, row]))

          for (const run of event.workflow_runs) {
            if (!byName.has(run.name)) {
              continue
            }

            byName.set(run.name, run)
          }

          return rows.map((row) => byName.get(row.name) ?? row)
        },
        refetchMode: "reset",
        streamFn: async ({ signal }) => {
          const result = await watchWorkflowRuns({
            baseUrl: await getGatewayBaseURL(),
            body: {
              run_names: workflowRuns.map((run) => run.name),
            },
            path: {
              agentName,
              workflowName,
            },
            signal,
          })

          return result.stream
        },
      }),
      queryKey: ["watchWorkflowRuns", agentName, workflowName, workflowRuns.map((run) => run.name)],
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: true,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: Infinity,
    })
  )
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()
  const rows = query.data ?? workflowRuns
  const columns = React.useMemo<ColumnDef<WorkflowRunSummary>[]>(
    () =>
      createColumns({
        agentName,
        canGoPrevious,
        deleteWorkflowRunAction,
        goPrevious,
        pageRowCount: rows.length,
        workflowName,
      }),
    [agentName, canGoPrevious, deleteWorkflowRunAction, goPrevious, rows.length, workflowName]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
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
      <div className="w-full min-w-0 overflow-hidden border-b">
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
                <TableRow key={row.id}>
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
                  No workflow runs
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 px-2">
        <Button variant="ghost" size="sm" onClick={goPrevious} disabled={!canGoPrevious || pending}>
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => goNext(nextPageToken)}
          disabled={!hasNextPage || pending}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function createColumns({
  agentName,
  canGoPrevious,
  deleteWorkflowRunAction,
  goPrevious,
  pageRowCount,
  workflowName,
}: {
  agentName: string
  canGoPrevious: boolean
  deleteWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    state: DeleteWorkflowRunActionState,
    formData: FormData
  ) => Promise<DeleteWorkflowRunActionState>
  goPrevious: () => void
  pageRowCount: number
  workflowName: string
}): ColumnDef<WorkflowRunSummary>[] {
  return [
    {
      accessorKey: "name",
      header: "Run",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: "workflow_name",
      header: "Workflow",
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.workflow_name}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <RunStatusBadge reason={row.original.reason} status={row.original.status} />
      ),
    },
    {
      accessorFn: (row) => row.duration_seconds ?? Number.POSITIVE_INFINITY,
      id: "duration_seconds",
      header: "Duration",
      sortingFn: "basic",
      sortUndefined: "last",
      cell: ({ row }) => {
        const durationSeconds = row.original.duration_seconds
        if (durationSeconds === undefined) {
          return <span className="text-muted-foreground">-</span>
        }

        const hours = Math.floor(durationSeconds / 3600)
        const minutes = Math.floor((durationSeconds % 3600) / 60)
        const seconds = durationSeconds % 60

        if (hours > 0) {
          return `${hours}h ${minutes}m`
        }
        if (minutes > 0) {
          return `${minutes}m ${seconds}s`
        }
        return `${seconds}s`
      },
    },
    {
      accessorKey: "created_at",
      header: "Age",
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
        <RunActions
          agentName={agentName}
          canGoPrevious={canGoPrevious}
          deleteWorkflowRunAction={deleteWorkflowRunAction}
          goPrevious={goPrevious}
          isOnlyRow={pageRowCount === 1}
          item={row.original}
          workflowName={workflowName}
        />
      ),
    },
  ]
}

function RunStatusBadge({ reason, status }: { reason: string; status: WorkflowRunStatus }) {
  const meta = runStatusMeta[status]
  const icon = <meta.icon data-icon="inline-start" />
  const badge = (
    <Badge variant={meta.variant}>
      {icon}
      {meta.label}
    </Badge>
  )

  if (reason.length === 0) {
    return badge
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function RunActions({
  agentName,
  canGoPrevious,
  deleteWorkflowRunAction,
  goPrevious,
  isOnlyRow,
  item,
  workflowName,
}: {
  agentName: string
  canGoPrevious: boolean
  deleteWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    state: DeleteWorkflowRunActionState,
    formData: FormData
  ) => Promise<DeleteWorkflowRunActionState>
  goPrevious: () => void
  isOnlyRow: boolean
  item: WorkflowRunSummary
  workflowName: string
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const detailQuery = useQuery(
    queryOptions({
      enabled: menuOpen,
      queryKey: ["workflowRun", agentName, workflowName, item.name] as const,
      queryFn: async (): Promise<WorkflowRunDetail> => {
        const result = await getWorkflowRun({
          baseUrl: await getGatewayBaseURL(),
          path: {
            agentName,
            workflowName,
            runName: item.name,
          },
        })
        if (result.error || !result.data) {
          throw new Error(result.error?.message ?? "Failed to load workflow run")
        }

        return result.data
      },
      retry: false,
      staleTime: 60 * 1000,
    })
  )

  return (
    <>
      <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <OpenSessionMenuItem
                agentName={agentName}
                detail={detailQuery.data}
                isPending={detailQuery.isPending}
              />
              <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeleteRunDialog
        agentName={agentName}
        canGoPrevious={canGoPrevious}
        deleteWorkflowRunAction={deleteWorkflowRunAction}
        goPrevious={goPrevious}
        isOnlyRow={isOnlyRow}
        item={item}
        open={deleteOpen}
        setOpen={setDeleteOpen}
        workflowName={workflowName}
      />
    </>
  )
}

function OpenSessionMenuItem({
  agentName,
  detail,
  isPending,
}: {
  agentName: string
  detail?: WorkflowRunDetail
  isPending: boolean
}) {
  if (isPending) {
    return (
      <DropdownMenuItem disabled>
        <Skeleton className="h-4 w-24" />
      </DropdownMenuItem>
    )
  }

  if (!detail?.session_id) {
    return (
      <DropdownMenuItem disabled>
        <ExternalLink />
        Open session
      </DropdownMenuItem>
    )
  }

  const sessionHref =
    `/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(detail.session_id)}` as Route

  return (
    <DropdownMenuItem asChild>
      <Link href={sessionHref} target="_blank" rel="noreferrer">
        <ExternalLink />
        Open session
      </Link>
    </DropdownMenuItem>
  )
}

function DeleteRunDialog({
  agentName,
  canGoPrevious,
  deleteWorkflowRunAction,
  goPrevious,
  isOnlyRow,
  item,
  open,
  setOpen,
  workflowName,
}: {
  agentName: string
  canGoPrevious: boolean
  deleteWorkflowRunAction: (
    agentName: string,
    workflowName: string,
    state: DeleteWorkflowRunActionState,
    formData: FormData
  ) => Promise<DeleteWorkflowRunActionState>
  goPrevious: () => void
  isOnlyRow: boolean
  item: WorkflowRunSummary
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  workflowName: string
}) {
  const router = useRouter()
  const [state, formAction, pending] = React.useActionState(
    deleteWorkflowRunAction.bind(null, agentName, workflowName),
    {
      success: false,
      error: undefined,
    }
  )

  React.useEffect(() => {
    if (pending || !state.success) {
      return
    }

    setOpen(false)
    if (isOnlyRow && canGoPrevious) {
      goPrevious()
      return
    }

    router.refresh()
  }, [canGoPrevious, goPrevious, isOnlyRow, pending, router, setOpen, state.success])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {item.name}?</DialogTitle>
          <DialogDescription>
            This will delete the workflow run permanently. This action cannot be undone.
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
          <form action={formAction}>
            <input type="hidden" name="run_name" value={item.name} />
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
