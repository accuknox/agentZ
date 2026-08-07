"use client"

import * as React from "react"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import type { Route } from "next"
import Link from "next/link"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Eye,
  Layers3,
  MoreHorizontal,
  Pencil,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { deleteInferencePoolAction } from "@/data/inference-pool.actions"
import type { InferencePoolActionScope } from "@/data/inference-pool.actions"
import { formatAge, formatCompactNumber } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  getInferencePool,
  getInferencePoolUsage,
  watchInferencePools,
  type InferencePool,
  type InferenceProvider,
  type WatchInferencePoolsEvent,
} from "@/lib/gateway/client"
import { ProviderIcon } from "../providers/provider-shared"
import { PoolSheet } from "./pool-sheet"

const pageSize = 25

const columnClassName: Record<string, string> = {
  display_name: "min-w-0 w-0",
  state: "w-44",
  members: "w-64 max-w-64",
  automatic_failover: "w-40",
  usage_count: "w-24",
  updated_at: "w-28",
  actions: "w-14",
}

const stateMeta = {
  Accepted: { icon: CircleDashed, variant: "pending" },
  Ready: { icon: CheckCircle2, variant: "success" },
  PartiallyDegraded: { icon: TriangleAlert, variant: "warning" },
  Degraded: { icon: XCircle, variant: "destructive" },
} satisfies Record<
  InferencePool["state"],
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

const watchPoolsQueryOptions = (
  poolIDs: string[],
  pools: InferencePool[],
  scope: InferencePoolActionScope
) =>
  queryOptions({
    queryKey: ["watchInferencePools", scope.workspaceId, poolIDs] as const,
    enabled: poolIDs.length > 0,
    placeholderData: pools,
    queryFn: streamedQuery<
      WatchInferencePoolsEvent,
      InferencePool[],
      readonly ["watchInferencePools", string, string[]]
    >({
      initialValue: pools,
      reducer: (rows, event) => {
        const updates = new Map(event.pools.map((pool) => [pool.id, pool]))
        return rows.map((pool) => updates.get(pool.id) ?? pool)
      },
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchInferencePools({
          baseUrl: await getGatewayBaseURL(),
          body: { pool_ids: poolIDs },
          headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
          signal,
        })
        return result.stream
      },
    }),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    staleTime: Infinity,
  })

export function InferencePoolTable({
  pools,
  providers,
  scope,
}: {
  pools: InferencePool[]
  providers: InferenceProvider[]
  scope: InferencePoolActionScope
}) {
  "use no memo"

  const [viewing, setViewing] = React.useState<InferencePool>()
  const [editing, setEditing] = React.useState<InferencePool>()
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "updated_at", desc: true }])
  const [page, setPage] = React.useState(0)
  const pageCount = Math.max(1, Math.ceil(pools.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const poolIDs = React.useMemo(() => {
    const ordered = [...pools]
    const sort = sorting[0]
    if (sort?.id === "display_name") {
      ordered.sort((a, b) => a.display_name.localeCompare(b.display_name))
    } else {
      ordered.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    }
    if (sort?.desc) ordered.reverse()
    return ordered
      .slice(currentPage * pageSize, currentPage * pageSize + pageSize)
      .map((pool) => pool.id)
  }, [currentPage, pools, sorting])
  const watched = useQuery(watchPoolsQueryOptions(poolIDs, pools, scope)).data ?? pools
  const providerByID = React.useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers]
  )
  const columns = React.useMemo<ColumnDef<InferencePool>[]>(
    () => [
      {
        accessorKey: "display_name",
        header: ({ column }) => (
          <Button
            className="-ml-2"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Name <ArrowUpDown />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="block truncate font-medium">{row.original.display_name}</span>
        ),
      },
      {
        accessorKey: "state",
        header: "Status",
        cell: ({ row }) => <PoolStatusBadge pool={row.original} />,
      },
      {
        id: "members",
        header: "Members",
        cell: ({ row }) => {
          const primary = row.original.members[0]
          if (!primary) return null
          const provider = providerByID.get(primary.provider)
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 cursor-default items-center gap-2">
                  {provider ? (
                    <ProviderIcon
                      provider={provider.catalog_provider}
                      className="size-4 shrink-0"
                    />
                  ) : null}
                  <span className="min-w-0 truncate">
                    {provider?.display_name ?? primary.provider} / {primary.model}
                  </span>
                  {row.original.members.length > 1 ? (
                    <Badge variant="secondary" className="shrink-0">
                      +{row.original.members.length - 1}
                    </Badge>
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent
                sideOffset={6}
                className="max-w-[min(42rem,var(--radix-tooltip-content-available-width))] flex-col items-stretch gap-2 p-2.5"
              >
                {row.original.members.map((member, index) => {
                  const itemProvider = providerByID.get(member.provider)
                  return (
                    <div
                      key={`${member.provider}\u0000${member.model}`}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <span className="text-background/70 w-4 shrink-0 text-right tabular-nums">
                        {index + 1}
                      </span>
                      {itemProvider ? (
                        <ProviderIcon
                          provider={itemProvider.catalog_provider}
                          className="size-4 shrink-0"
                          inverted
                        />
                      ) : (
                        <Layers3 className="text-background/70 size-4 shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="font-medium">
                          {itemProvider?.display_name ?? member.provider}
                        </span>
                        <span className="text-background/80"> / {member.model}</span>
                      </span>
                    </div>
                  )
                })}
              </TooltipContent>
            </Tooltip>
          )
        },
      },
      {
        accessorKey: "automatic_failover",
        header: "Automatic failover",
        cell: ({ row }) => (row.original.automatic_failover ? "Enabled" : "Pinned"),
      },
      {
        accessorKey: "usage_count",
        header: "Used by",
      },
      {
        accessorKey: "updated_at",
        header: ({ column }) => (
          <Button
            className="-ml-2"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Updated <ArrowUpDown />
          </Button>
        ),
        cell: ({ row }) => formatAge(row.original.updated_at),
        sortingFn: (a, b) => Date.parse(a.original.updated_at) - Date.parse(b.original.updated_at),
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <PoolActions
            pool={row.original}
            scope={scope}
            view={() => setViewing(row.original)}
            edit={() => setEditing(row.original)}
          />
        ),
      },
    ],
    [providerByID, scope]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: watched,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  })
  const visibleRows = table
    .getRowModel()
    .rows.slice(currentPage * pageSize, currentPage * pageSize + pageSize)

  return (
    <TooltipProvider>
      <div className="min-w-0 space-y-4">
        <div className="w-full min-w-0 border-b">
          <Table className="table-auto">
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={`h-8 ${columnClassName[header.column.id] ?? "px-4"}`}
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
              {visibleRows.length ? (
                visibleRows.map((row) => (
                  <TableRow
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => setViewing(row.original)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      setViewing(row.original)
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={`h-11 py-2 align-middle ${columnClassName[cell.column.id] ?? "px-4"}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    No inference Pools
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2 px-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ArrowLeft /> Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next <ArrowRight />
          </Button>
        </div>
        <PoolViewSheet
          pool={viewing}
          providers={providers}
          open={Boolean(viewing)}
          onOpenChange={(open) => !open && setViewing(undefined)}
          scope={scope}
        />
        <PoolSheet
          key={editing?.id ?? "closed"}
          pool={editing}
          providers={providers}
          open={Boolean(editing)}
          onOpenChange={(open) => !open && setEditing(undefined)}
          scope={scope}
        />
      </div>
    </TooltipProvider>
  )
}

function PoolStatusBadge({ pool }: { pool: InferencePool }) {
  const meta = stateMeta[pool.state]
  const failures = pool.member_statuses.filter((member) => !member.ready)
  const message =
    pool.state === "PartiallyDegraded"
      ? failures.map((member) => `${member.provider}/${member.model}: ${member.message}`).join("\n")
      : pool.state === "Degraded"
        ? (pool.conditions.find((condition) => condition.status === "False")?.message ?? "")
        : ""
  const badge = (
    <Badge variant={meta.variant}>
      <meta.icon /> {pool.state === "PartiallyDegraded" ? "Partial" : pool.state}
    </Badge>
  )
  if (!message) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-96 whitespace-pre-line">{message}</TooltipContent>
    </Tooltip>
  )
}

function PoolActions({
  pool,
  scope,
  view,
  edit,
}: {
  pool: InferencePool
  scope: InferencePoolActionScope
  view: () => void
  edit: () => void
}) {
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
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={view}>
              <Eye /> View
            </DropdownMenuItem>
            {pool.can_modify ? (
              <DropdownMenuItem onSelect={edit}>
                <Pencil /> Edit
              </DropdownMenuItem>
            ) : null}
            {pool.can_delete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeletePoolDialog pool={pool} open={deleteOpen} scope={scope} setOpen={setDeleteOpen} />
    </div>
  )
}

function DeletePoolDialog({
  pool,
  open,
  scope,
  setOpen,
}: {
  pool: InferencePool
  open: boolean
  scope: InferencePoolActionScope
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [error, setError] = React.useState("")
  const [pending, startTransition] = React.useTransition()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError("")
        setOpen(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {pool.display_name}?</DialogTitle>
          <DialogDescription>
            This Pool will no longer be available to Sandboxes. Remove it from every Sandbox first.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Pool could not be deleted</AlertTitle>
            <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteInferencePoolAction(scope, pool.id)
                if (result.error) {
                  const details =
                    result.error.errors?.map((item) => `${item.field}: ${item.message}`) ?? []
                  setError([result.error.message, ...details].join("\n"))
                  return
                }
                setOpen(false)
                toast.success("Inference Pool deleted")
              })
            }
          >
            {pending ? <Spinner /> : <Trash2 />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PoolViewSheet({
  pool,
  providers,
  open,
  onOpenChange,
  scope,
}: {
  pool?: InferencePool
  providers: InferenceProvider[]
  open: boolean
  onOpenChange: (open: boolean) => void
  scope: InferencePoolActionScope
}) {
  const poolName = pool?.id
  const query = useQuery(
    queryOptions({
      enabled: open && Boolean(poolName),
      queryKey: ["inference-pool", scope.workspaceId, poolName],
      queryFn: async () => {
        if (!poolName) throw new Error("Pool is unavailable")
        const baseUrl = await getGatewayBaseURL()
        const [detail, usage] = await Promise.all([
          getInferencePool({
            baseUrl,
            headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
            path: { poolName },
          }),
          getInferencePoolUsage({
            baseUrl,
            headers: { "X-AgentZ-Workspace-ID": scope.workspaceId },
            path: { poolName },
          }),
        ])
        if (detail.error) throw new Error(detail.error.message)
        if (usage.error) throw new Error(usage.error.message)
        return { pool: detail.data, usage: usage.data }
      },
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    })
  )
  const providerByID = new Map(providers.map((provider) => [provider.id, provider]))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="h-full overflow-y-auto sm:w-[45rem]! sm:max-w-none!">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Layers3 className="size-4" />
            Inference Pool
          </SheetTitle>
          <SheetDescription className="sr-only">View inference Pool</SheetDescription>
        </SheetHeader>
        {query.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : query.error instanceof Error ? (
          <div className="px-4">
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Pool could not be loaded</AlertTitle>
              <AlertDescription>{query.error.message}</AlertDescription>
            </Alert>
          </div>
        ) : query.data ? (
          <div className="space-y-6 px-4 pb-4">
            <DetailSection title="Identity">
              <DetailRow label="Name" value={query.data.pool.display_name} />
              <DetailRow label="ID" value={query.data.pool.id} />
              <DetailRow label="Status" value={<PoolStatusBadge pool={query.data.pool} />} />
            </DetailSection>
            <DetailSection title="Routing">
              <DetailRow
                label="Primary protocol"
                value={
                  query.data.pool.protocol ? (
                    <span className="flex items-center gap-2">
                      <ProviderIcon
                        provider={query.data.pool.protocol === "Anthropic" ? "anthropic" : "openai"}
                        className="size-4 shrink-0"
                      />
                      {query.data.pool.protocol}
                    </span>
                  ) : (
                    "Pending"
                  )
                }
              />
              <DetailRow
                label="Automatic failover"
                value={query.data.pool.automatic_failover ? "Enabled" : "Pinned to primary"}
              />
            </DetailSection>
            <DetailSection title="Pool Contract">
              {query.data.pool.contract ? (
                <>
                  <DetailRow
                    label="Input"
                    value={query.data.pool.contract.modalities.input.join(", ")}
                  />
                  <DetailRow
                    label="Output"
                    value={query.data.pool.contract.modalities.output.join(", ")}
                  />
                  <DetailRow
                    label="Context"
                    value={formatCompactNumber(query.data.pool.contract.limits.context)}
                  />
                  <DetailRow
                    label="Maximum input"
                    value={formatCompactNumber(
                      query.data.pool.contract.limits.input ??
                        query.data.pool.contract.limits.context
                    )}
                  />
                  <DetailRow
                    label="Maximum output"
                    value={formatCompactNumber(query.data.pool.contract.limits.output)}
                  />
                  <DetailRow
                    label="Capabilities"
                    value={
                      Object.entries(query.data.pool.contract.capabilities)
                        .filter(([, enabled]) => enabled)
                        .map(([name]) => name.replace("_", " "))
                        .join(", ") || "Text generation only"
                    }
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Shared model support is still being calculated.
                </p>
              )}
            </DetailSection>
            <DetailSection title="Members">
              <div className="divide-y rounded-lg border">
                {query.data.pool.members.map((member, index) => {
                  const provider = providerByID.get(member.provider)
                  const status = query.data.pool.member_statuses[index]
                  return (
                    <div
                      key={`${member.provider}\u0000${member.model}`}
                      className="flex min-w-0 items-center gap-2.5 px-3 py-2.5"
                    >
                      <span className="text-muted-foreground w-4 shrink-0 text-right text-sm tabular-nums">
                        {index + 1}
                      </span>
                      {provider ? (
                        <ProviderIcon
                          provider={provider.catalog_provider}
                          className="size-4 shrink-0"
                        />
                      ) : (
                        <Layers3 className="text-muted-foreground size-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">
                          {provider?.display_name ?? member.provider}
                        </span>
                        <span className="text-muted-foreground"> / {member.model}</span>
                      </span>
                      {status ? (
                        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
                          <ProviderIcon
                            provider={status.protocol === "Anthropic" ? "anthropic" : "openai"}
                            className="size-3.5"
                          />
                          {status.protocol}
                        </span>
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant={status?.ready ? "success" : "destructive"}>
                            {status?.ready ? "Ready" : status?.reason || "Pending"}
                          </Badge>
                        </TooltipTrigger>
                        {status?.message ? (
                          <TooltipContent sideOffset={6}>{status.message}</TooltipContent>
                        ) : null}
                      </Tooltip>
                    </div>
                  )
                })}
              </div>
            </DetailSection>
            <DetailSection title="Compatibility">
              {query.data.pool.warnings.length ? (
                query.data.pool.warnings.map((warning) => (
                  <Alert key={warning.code} variant="warning">
                    <TriangleAlert />
                    <AlertTitle>These models use different API formats</AlertTitle>
                    <AlertDescription>
                      Provider-specific features may not carry over when this Pool switches models.
                    </AlertDescription>
                  </Alert>
                ))
              ) : (
                <p className="text-muted-foreground text-sm">
                  All members use compatible request formats.
                </p>
              )}
            </DetailSection>
            <DetailSection title="Usage">
              {query.data.usage.sandboxes.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {query.data.usage.sandboxes.map((sandbox) => (
                    <Link
                      key={sandbox}
                      href={
                        `${scope.basePath}/sandboxes/update/${encodeURIComponent(sandbox)}` as Route
                      }
                      className="hover:bg-accent focus-visible:ring-ring flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors outline-none focus-visible:ring-2"
                    >
                      <span className="break-anywhere min-w-0">{sandbox}</span>
                      <ArrowUpRight className="text-muted-foreground size-4 shrink-0" />
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No Sandboxes use this Pool.</p>
              )}
            </DetailSection>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="break-anywhere min-w-0 text-sm">{value}</div>
    </div>
  )
}
