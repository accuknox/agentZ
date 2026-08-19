"use client"

import * as React from "react"
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  useQuery,
} from "@tanstack/react-query"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
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
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/avatar"
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
import { TokenTablePagination } from "@/components/table-pagination"
import { deleteInferenceProviderAction } from "@/data/inference-provider.actions"
import type { InferenceProviderActionScope } from "@/data/inference-provider.actions"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import {
  watchInferenceProviders,
  type InferenceProvider,
  type WatchInferenceProvidersEvent,
} from "@/lib/gateway/client"
import { ProviderSheet } from "./provider-sheet"
import { ProviderIcon, providerKindLabels } from "./provider-shared"

const layout: Record<string, AdminColumnLayout> = {
  display_name: { minWidth: 224, contentMaxWidth: 320 },
  kind: { minWidth: 128, width: 128 },
  state: { minWidth: 128, width: 128 },
  model_count: { minWidth: 96, width: 96 },
  usage_count: { minWidth: 96, width: 96 },
  created_by: { minWidth: 96, width: 96, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 104, width: 104, hiddenBelow: "lg" },
  updated_at: { minWidth: 128, width: 128 },
  actions: { minWidth: 64, width: 64 },
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
      reducer: (rows, event) => {
        const updates = new Map(
          event.providers.map((provider) => [
            JSON.stringify([provider.scope, provider.id]),
            provider,
          ])
        )
        return rows.map(
          (provider) => updates.get(JSON.stringify([provider.scope, provider.id])) ?? provider
        )
      },
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
  canCreate,
  hasNextPage,
  nextPageToken,
  providers,
  scope,
}: {
  canCreate: boolean
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
            {scope.workspaceId !== undefined && row.original.scope === "Organisation" ? (
              <Badge variant="secondary">Organization</Badge>
            ) : null}
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
        accessorKey: "updated_at",
        header: "Updated",
        cell: ({ row }) => <RelativeDateTime value={row.original.updated_at} />,
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
    manualPagination: true,
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AdminDataGrid
        ariaLabel="Inference providers"
        emptyState={
          <AdministrationState
            description="Add a provider so your agents can access inference models."
            kind={canCreate ? "welcome" : "empty"}
            title="Let's add your first inference provider"
          />
        }
        layout={layout}
        onRowActivate={setEditing}
        pagination={
          <TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />
        }
        rowAriaLabel={(provider) => `Edit ${provider.display_name}`}
        rowCanActivate={(provider) => provider.can_modify}
        rows={watched}
        table={table}
      />
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
          <Alert variant="destructive" className="-mx-4 w-[calc(100%+2rem)] max-w-none px-4">
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
