"use client"

import * as React from "react"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import { flexRender, getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import {
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
import { TokenTablePagination } from "@/components/table-pagination"
import { deleteInferenceProviderAction } from "@/data/inference-provider.actions"
import type { InferenceProviderActionScope } from "@/data/inference-provider.actions"
import { formatAge } from "@/lib/format"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  watchInferenceProviders,
  type InferenceProvider,
  type WatchInferenceProvidersEvent,
} from "@/lib/gateway/client"
import { ProviderSheet } from "./provider-sheet"
import { ProviderIcon, providerKindLabels } from "./provider-shared"

const columnClassName: Record<string, string> = {
  display_name: "w-64",
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

const watchProvidersQueryOptions = (
  providers: InferenceProvider[],
  scope: InferenceProviderActionScope
) =>
  queryOptions({
    queryKey: ["watchInferenceProviders", scope.workspaceId ?? "organization"] as const,
    placeholderData: providers,
    queryFn: streamedQuery<
      WatchInferenceProvidersEvent,
      InferenceProvider[],
      readonly ["watchInferenceProviders", string]
    >({
      initialValue: providers,
      reducer: (_, event) =>
        scope.workspaceId
          ? [
              ...event.providers,
              ...providers.filter((provider) => provider.scope === "Organisation"),
            ]
          : event.providers,
      refetchMode: "reset",
      streamFn: async ({ signal }) => {
        const result = await watchInferenceProviders({
          baseUrl: await getGatewayBaseURL(),
          body: {},
          headers: scope.workspaceId ? { "X-AgentZ-Workspace-ID": scope.workspaceId } : undefined,
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

export function InferenceProviderTable({
  hasNextPage,
  nextPageToken,
  providers,
  scope,
}: {
  hasNextPage: boolean
  nextPageToken: string
  providers: InferenceProvider[]
  scope: InferenceProviderActionScope
}) {
  "use no memo"

  const watched = useQuery(watchProvidersQueryOptions(providers, scope)).data ?? providers
  const [editing, setEditing] = React.useState<InferenceProvider>()
  const columns = React.useMemo<ColumnDef<InferenceProvider>[]>(
    () => [
      {
        accessorKey: "display_name",
        header: "Name",
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
        header: "Updated",
        cell: ({ row }) => <span>{formatAge(row.original.updated_at)}</span>,
        sortingFn: (a, b) => Date.parse(a.original.updated_at) - Date.parse(b.original.updated_at),
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <ProviderActions provider={row.original} scope={scope} onEditAction={setEditing} />
        ),
      },
    ],
    [scope]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: watched,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table className="w-full table-fixed">
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
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={row.original.can_modify ? "cursor-pointer" : undefined}
                  role={row.original.can_modify ? "button" : undefined}
                  tabIndex={row.original.can_modify ? 0 : undefined}
                  onClick={() => {
                    if (row.original.can_modify) setEditing(row.original)
                  }}
                  onKeyDown={(event) => {
                    if (!row.original.can_modify || (event.key !== "Enter" && event.key !== " ")) {
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
      <TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />

      <ProviderSheet
        key={editing?.id ?? "closed"}
        provider={editing}
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined)
          }
        }}
        scope={scope}
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
  scope,
  onEditAction,
}: {
  provider: InferenceProvider
  scope: InferenceProviderActionScope
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
      {provider.can_modify || provider.can_delete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {provider.can_modify ? (
                <DropdownMenuItem onSelect={() => onEditAction(provider)}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
              ) : null}
              {provider.can_delete ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DeleteProviderDialog
        provider={provider}
        open={deleteOpen}
        scope={scope}
        setOpen={setDeleteOpen}
      />
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
  scope,
  setOpen,
}: {
  provider: InferenceProvider
  open: boolean
  scope: InferenceProviderActionScope
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
                const result = await deleteInferenceProviderAction(scope, provider.id)
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
