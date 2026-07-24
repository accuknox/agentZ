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
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  MoreHorizontal,
  Pencil,
  Trash2,
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
import { deleteInferenceProviderAction } from "@/data/inference-provider.actions"
import { formatAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  watchInferenceProviders,
  type InferenceProvider,
  type WatchInferenceProvidersEvent,
} from "@/lib/gateway/client"
import { ProviderSheet } from "./provider-sheet"
import { ProviderIcon, providerKindLabels } from "./provider-shared"

const pageSize = 25

const columnClassName: Record<string, string> = {
  display_name: "min-w-0 w-0",
  kind: "w-44",
  state: "w-36",
  model_count: "w-28",
  usage_count: "w-28",
  updated_at: "w-32",
  actions: "w-14",
}

const providerStateMeta = {
  Accepted: {
    icon: CircleDashed,
    variant: "pending",
  },
  Ready: {
    icon: CheckCircle2,
    variant: "success",
  },
  Degraded: {
    icon: XCircle,
    variant: "destructive",
  },
} satisfies Record<
  InferenceProvider["state"],
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

const watchProvidersQueryOptions = (providers: InferenceProvider[]) =>
  queryOptions({
    queryKey: ["watchInferenceProviders"] as const,
    placeholderData: providers,
    queryFn: streamedQuery<
      WatchInferenceProvidersEvent,
      InferenceProvider[],
      readonly ["watchInferenceProviders"]
    >({
      initialValue: providers,
      reducer: (_, event) => event.providers,
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchInferenceProviders({
          baseUrl: await getGatewayBaseURL(),
          body: {},
          signal,
        })
        return result.stream
      },
    }),
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    refetchOnWindowFocus: false,
    retry: true,
    staleTime: Infinity,
  })

export function InferenceProviderTable({ providers }: { providers: InferenceProvider[] }) {
  "use no memo"

  const watched = useQuery(watchProvidersQueryOptions(providers)).data ?? providers
  const [editing, setEditing] = React.useState<InferenceProvider>()
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "updated_at", desc: true }])
  const [page, setPage] = React.useState(0)

  const pageCount = Math.max(1, Math.ceil(watched.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const columns = React.useMemo<ColumnDef<InferenceProvider>[]>(
    () => [
      {
        accessorKey: "display_name",
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
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderIcon provider={row.original.catalog_provider} className="size-4 shrink-0" />
            <span className="min-w-0 truncate font-medium">{row.original.display_name}</span>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <span>{providerKindLabels[row.original.kind]}</span>,
      },
      {
        accessorKey: "state",
        header: "Status",
        cell: ({ row }) => <ProviderStatusBadge provider={row.original} />,
      },
      {
        accessorKey: "model_count",
        header: "Models",
        cell: ({ row }) => <span>{row.original.model_count}</span>,
      },
      {
        accessorKey: "usage_count",
        header: "Used by",
        cell: ({ row }) => <span>{row.original.usage_count}</span>,
      },
      {
        accessorKey: "updated_at",
        header: ({ column }) => (
          <Button
            className="-ml-2"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Updated
            <ArrowUpDown />
          </Button>
        ),
        cell: ({ row }) => <span>{formatAge(row.original.updated_at)}</span>,
        sortingFn: (a, b) => Date.parse(a.original.updated_at) - Date.parse(b.original.updated_at),
      },
      {
        id: "actions",
        cell: ({ row }) => <ProviderActions provider={row.original} onEditAction={setEditing} />,
      },
    ],
    []
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
    <div className="min-w-0 space-y-4">
      <div className="w-full min-w-0 border-b">
        <Table className="table-auto">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
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
            {visibleRows.length > 0 ? (
              visibleRows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditing(row.original)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") {
                      return
                    }

                    event.preventDefault()
                    setEditing(row.original)
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
                  No inference providers
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
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={currentPage + 1 === pageCount}
          onClick={() => setPage(currentPage + 1)}
        >
          Next
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>

      <ProviderSheet
        key={editing?.id ?? "closed"}
        provider={editing}
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined)
          }
        }}
      />
    </div>
  )
}

/**
 * ProviderStatusBadge maps the provider condition state onto a badge and
 * surfaces the failing condition message on hover, matching the MCP table.
 */
function ProviderStatusBadge({ provider }: { provider: InferenceProvider }) {
  const meta = providerStateMeta[provider.state]
  const message =
    provider.state === "Degraded"
      ? (provider.conditions.find((condition) => condition.status === "False")?.message.trim() ??
        "")
      : ""
  const badge = (
    <Badge variant={meta.variant}>
      <meta.icon data-icon="inline-start" />
      {provider.state}
    </Badge>
  )

  if (!message) {
    return badge
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  )
}

/** ProviderActions renders the per-row menu and its delete confirmation. */
function ProviderActions({
  provider,
  onEditAction,
}: {
  provider: InferenceProvider
  onEditAction: (provider: InferenceProvider) => void
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  return (
    <div
      className="flex justify-end"
      onClick={(event) => {
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
      }}
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
            <DropdownMenuItem onSelect={() => onEditAction(provider)}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteProviderDialog provider={provider} open={deleteOpen} setOpen={setDeleteOpen} />
    </div>
  )
}

/**
 * DeleteProviderDialog confirms removal and surfaces backend validation
 * errors, such as the provider still being referenced by a sandbox.
 */
function DeleteProviderDialog({
  provider,
  open,
  setOpen,
}: {
  provider: InferenceProvider
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [error, setError] = React.useState("")
  const [pending, startTransition] = React.useTransition()

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setError("")
        setOpen(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {provider.display_name}?</DialogTitle>
          <DialogDescription>
            This will delete the inference provider and its stored credentials. Providers used by
            Pools or Sandboxes cannot be deleted.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Provider could not be deleted</AlertTitle>
            <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                const result = await deleteInferenceProviderAction(provider.id)
                if (result.error) {
                  const details = result.error.errors?.map(
                    (fieldError) => `${fieldError.field}: ${fieldError.message}`
                  )
                  setError([result.error.message, ...(details ?? [])].join("\n"))
                  return
                }
                setOpen(false)
                toast.success("Inference provider deleted")
              })
            }}
          >
            {pending ? <Spinner /> : <Trash2 />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
