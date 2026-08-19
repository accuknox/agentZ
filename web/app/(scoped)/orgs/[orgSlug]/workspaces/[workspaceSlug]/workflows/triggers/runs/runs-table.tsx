"use client"

import * as React from "react"
import { toast } from "sonner"
import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "@bprogress/next/app"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
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
  GitBranch,
  MoreHorizontal,
  Trash2,
  XCircle,
} from "lucide-react"
import { formatDurationSeconds } from "@/lib/format"
import {
  getWorkflowRun,
  watchWorkflowRuns,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WatchWorkflowRunsResponse,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { TokenTablePagination } from "@/components/table-pagination"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { useTokenPagination } from "@/lib/use-token-pagination"
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
import { Spinner } from "@/components/ui/spinner"
import { RelativeDateTime } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { DeleteWorkflowRunActionState } from "@/data/workflow-run.actions"

const layout: Record<string, AdminColumnLayout> = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  workflow_name: { minWidth: 176, contentMaxWidth: 288 },
  status: { minWidth: 160, width: 160 },
  duration_seconds: { minWidth: 112, width: 112 },
  created_at: { minWidth: 144, width: 144 },
  actions: { minWidth: 64, width: 64 },
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
  basePath,
  workflowName,
  workflowRuns,
  hasNextPage,
  nextPageToken,
  deleteWorkflowRunAction,
  workspaceId,
}: {
  agentName: string
  basePath: string
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
  workspaceId: string
}) {
  "use no memo"

  const query = useQuery(
    queryOptions({
      enabled: workflowRuns.length > 0,
      placeholderData: workflowRuns,
      queryFn: streamedQuery<
        WatchWorkflowRunsResponse,
        WorkflowRunSummary[],
        readonly ["watchWorkflowRuns", string, string, string, string[]]
      >({
        initialValue: workflowRuns,
        reducer: (rows, event) => {
          const byName = new Map(rows.map((row) => [row.name, row]))

          for (const run of event.workflow_runs) {
            if (!byName.has(run.name)) {
              continue
            }

            byName.set(run.name, {
              name: run.name,
              workflow_name: run.workflow_name,
              trigger_type: run.trigger_type,
              schedule_name: run.schedule_name,
              status: run.status,
              reason: run.reason,
              created_at: run.created_at,
              duration_seconds: run.duration_seconds,
            })
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
            headers: { "X-AgentZ-Workspace-ID": workspaceId },
            path: {
              agentName,
              workflowName,
            },
            signal,
          })

          return result.stream
        },
      }),
      queryKey: [
        "watchWorkflowRuns",
        workspaceId,
        agentName,
        workflowName,
        workflowRuns.map((run) => run.name),
      ],
      refetchOnMount: "always",
      refetchOnReconnect: "always",
      refetchOnWindowFocus: false,
      retry: true,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      staleTime: Infinity,
    })
  )
  const { canGoPrevious, goPrevious } = useTokenPagination({
    pageTokenKey: "page_token",
    tokenStackKey: "token_stack",
  })
  const rows = query.data ?? workflowRuns
  const columns = React.useMemo<ColumnDef<WorkflowRunSummary>[]>(
    () =>
      createColumns({
        agentName,
        basePath,
        canGoPrevious,
        deleteWorkflowRunAction,
        goPrevious,
        pageRowCount: rows.length,
        workflowName,
        workspaceId,
      }),
    [
      agentName,
      basePath,
      canGoPrevious,
      deleteWorkflowRunAction,
      goPrevious,
      rows.length,
      workflowName,
      workspaceId,
    ]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  })

  return (
    <AdminDataGrid
      ariaLabel="Workflow runs"
      emptyState={<p className="text-muted-foreground py-8 text-center">No runs found.</p>}
      layout={layout}
      pagination={<TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />}
      rowHref={(run) => runGraphHref(basePath, agentName, workflowName, run.name)}
      rows={rows}
      table={table}
    />
  )
}

function createColumns({
  agentName,
  basePath,
  canGoPrevious,
  deleteWorkflowRunAction,
  goPrevious,
  pageRowCount,
  workflowName,
  workspaceId,
}: {
  agentName: string
  basePath: string
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
  workspaceId: string
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
      cell: ({ row }) => {
        const durationSeconds = row.original.duration_seconds
        if (durationSeconds === undefined) {
          return <span className="text-muted-foreground">-</span>
        }

        return formatDurationSeconds(durationSeconds)
      },
    },
    {
      accessorKey: "created_at",
      header: "Age",
      cell: ({ row }) => {
        return <RelativeDateTime value={row.original.created_at} />
      },
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <RunActions
          agentName={agentName}
          basePath={basePath}
          canGoPrevious={canGoPrevious}
          deleteWorkflowRunAction={deleteWorkflowRunAction}
          goPrevious={goPrevious}
          isOnlyRow={pageRowCount === 1}
          item={row.original}
          workflowName={workflowName}
          workspaceId={workspaceId}
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
  basePath,
  canGoPrevious,
  deleteWorkflowRunAction,
  goPrevious,
  isOnlyRow,
  item,
  workflowName,
  workspaceId,
}: {
  agentName: string
  basePath: string
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
  workspaceId: string
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const detailQuery = useQuery(
    queryOptions({
      enabled: menuOpen,
      queryKey: ["workflowRun", workspaceId, agentName, workflowName, item.name] as const,
      queryFn: async (): Promise<WorkflowRunDetail> => {
        const result = await getWorkflowRun({
          baseUrl: await getGatewayBaseURL(),
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
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
      <div
        className="flex justify-end"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
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
                basePath={basePath}
                detail={detailQuery.data}
                isFetching={detailQuery.isFetching}
              />
              <DropdownMenuItem asChild>
                <Link href={runGraphHref(basePath, agentName, workflowName, item.name)}>
                  <GitBranch />
                  View graph
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
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

function runGraphHref(
  basePath: string,
  agentName: string,
  workflowName: string,
  runName: string
): Route {
  const params = new URLSearchParams()
  params.set("agent_name", agentName)
  params.set("workflow_name", workflowName)
  params.set("run_name", runName)
  return `${basePath}/workflows/triggers/runs/graph?${params.toString()}` as Route
}

function OpenSessionMenuItem({
  agentName,
  basePath,
  detail,
  isFetching,
}: {
  agentName: string
  basePath: string
  detail?: WorkflowRunDetail
  isFetching: boolean
}) {
  if (isFetching) {
    return (
      <DropdownMenuItem disabled>
        <Spinner />
        Open session
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
    `${basePath}/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(detail.session_id)}` as Route

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

    toast.success("Workflow run deleted")
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
