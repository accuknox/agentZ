"use client"

import { useMemo, useState, useTransition } from "react"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { AppWindow, Eye, MoreHorizontal, Unplug } from "lucide-react"
import { toast } from "sonner"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { RelativeDateTime } from "@/components/ui/table"
import type { DelegationCatalog } from "@/lib/gateway/client"
import { ApplicationAccessSheet } from "./application-access-sheet"
import { disconnectApplicationAction } from "./actions"

export type ConnectedApplication = {
  clientId: string
  name: string
  owner: string | null
  scopes: string[]
  grants: { organization: string | null; selection: DelegationCatalog }[]
  createdAt: string
}

const layout = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  owner: { minWidth: 160, contentMaxWidth: 224, hiddenBelow: "md" },
  scopes: { minWidth: 160, width: 160, contentMaxWidth: 144, hiddenBelow: "md" },
  access: { minWidth: 192, contentMaxWidth: 240, hiddenBelow: "sm" },
  connected: { minWidth: 128, width: 128, hiddenBelow: "lg" },
  actions: { minWidth: 64, width: 64, align: "end" },
} satisfies Record<string, AdminColumnLayout>

export function ConnectedApplications({
  applications,
  workspaces,
}: {
  applications: ConnectedApplication[]
  workspaces: Record<string, string>
}) {
  "use no memo"

  const [details, setDetails] = useState<ConnectedApplication>()
  const [selected, setSelected] = useState<ConnectedApplication>()
  const [pending, startTransition] = useTransition()
  const columns = useMemo<ColumnDef<ConnectedApplication>[]>(
    () => [
      {
        id: "name",
        header: "Application",
        cell: ({ row: { original: application } }) => (
          <div className="flex min-w-0 items-center gap-2">
            <AppWindow aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="max-w-48 truncate font-medium sm:max-w-none" title={application.name}>
              {application.name}
            </span>
          </div>
        ),
      },
      {
        id: "owner",
        header: "Owned by",
        cell: ({ row }) => (
          <span
            className="block truncate text-muted-foreground"
            title={row.original.owner ?? undefined}
          >
            {row.original.owner ?? "Unknown owner"}
          </span>
        ),
      },
      {
        id: "scopes",
        header: "Permissions",
        cell: ({ row }) => <ApplicationValues values={row.original.scopes} />,
      },
      {
        id: "access",
        header: "Resource access",
        cell: ({ row }) => {
          const resources = new Map(
            row.original.grants.flatMap(({ selection }) => [
              ...selection.models.map(
                (model) =>
                  [
                    model.id,
                    `${model.provider_display_name || model.provider} / ${model.model_display_name || model.model}`,
                  ] as const
              ),
              ...selection.mcp.map((connection) => [connection.id, connection.connection] as const),
            ])
          )
          return <ApplicationValues values={[...resources.values()]} />
        },
      },
      {
        id: "connected",
        header: "Connected",
        cell: ({ row }) => <RelativeDateTime value={row.original.createdAt} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original: application } }) => (
          <div
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Actions for ${application.name}`}
                  disabled={pending}
                >
                  <MoreHorizontal aria-hidden="true" className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => setDetails(application)}>
                    <Eye aria-hidden="true" />
                    View access
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setSelected(application)}>
                    <Unplug aria-hidden="true" />
                    Disconnect
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [pending]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: applications,
    columns,
    getRowId: (application) => application.clientId,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <>
      <AdminDataGrid
        ariaLabel="Connected applications"
        rows={applications}
        table={table}
        layout={layout}
        onRowActivate={setDetails}
        rowAriaLabel={(application) => `View access for ${application.name}`}
        emptyState={
          <AdministrationState
            kind="empty"
            title="No connected applications"
            description="Applications appear here after you allow them to access your AgentZ account."
          />
        }
      />
      {details ? (
        <ApplicationAccessSheet
          application={details}
          workspaces={workspaces}
          onClose={() => setDetails(undefined)}
        />
      ) : null}
      <Dialog
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!pending && !open) setSelected(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {selected?.name}?</DialogTitle>
            <DialogDescription>
              This revokes every authorization for this application. It cannot start new requests or
              refresh access. Work already dispatched may finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setSelected(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!selected) return
                  try {
                    const result = await disconnectApplicationAction(selected.clientId)
                    if ("error" in result) {
                      toast.error(result.error)
                      return
                    }
                    setSelected(undefined)
                    setDetails(undefined)
                    toast.success("Application disconnected")
                  } catch {
                    toast.error("The application could not be disconnected. Try again.")
                  }
                })
              }
            >
              {pending ? <Spinner /> : <Unplug aria-hidden="true" data-icon="inline-start" />}
              {pending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ApplicationValues({ values }: { values: string[] }) {
  if (!values.length) return <span className="text-muted-foreground">None</span>

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="flex min-w-0 items-center gap-2">
          <span className="truncate text-muted-foreground">{values[0]}</span>
          {values.length > 1 ? <Badge variant="secondary">+{values.length - 1}</Badge> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-96 break-all whitespace-pre-line">
        {values.join("\n")}
      </TooltipContent>
    </Tooltip>
  )
}
