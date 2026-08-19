"use client"

import { useMemo, useState } from "react"
import {
  type CellContext,
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { AdministrationPageHeader } from "@/components/administration"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { EventsChart } from "@/components/events-chart"
import { TokenTablePagination } from "@/components/table-pagination"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { UserIdentity } from "@/components/ui/avatar"
import { RelativeDateTime } from "@/components/ui/table"
import type {
  EventTrailEvent,
  EventTrailFilter,
  ListEventTrailEventsResponse,
} from "@/lib/gateway/client"
import type { EventsChartData } from "@/data/types"
import { ResultBadge } from "./event-trail-event"
import { EventTrailFilters } from "./event-trail-filters"

const layout: Record<string, AdminColumnLayout> = {
  created_at: { minWidth: 144, width: 144 },
  actor: { minWidth: 224, contentMaxWidth: 288, hiddenBelow: "md" },
  action: { minWidth: 192, contentMaxWidth: 288, pin: "start" },
  target: { minWidth: 224, contentMaxWidth: 288 },
  workspace: { minWidth: 224, contentMaxWidth: 288, hiddenBelow: "lg" },
  result: { minWidth: 112, width: 112 },
}

export function EventTrailEvents({
  actorImages,
  chart,
  eventTrail,
  filters,
  workspace,
}: {
  actorImages: Record<string, string>
  chart: EventsChartData
  eventTrail: ListEventTrailEventsResponse
  filters: EventTrailFilter[]
  workspace?: { name: string }
}) {
  "use no memo"

  const [selected, setSelected] = useState<EventTrailEvent>()
  const columns = useMemo<ColumnDef<EventTrailEvent>[]>(
    () => [
      {
        accessorKey: "created_at",
        header: "Time",
        cell: ({ row }) => <RelativeDateTime className="text-xs" value={row.original.created_at} />,
      },
      {
        id: "actor",
        header: "Actor",
        cell: ({ row }) => (
          <UserIdentity
            email={row.original.actor.email}
            image={row.original.actor.id ? actorImages[row.original.actor.id] : undefined}
            name={row.original.actor.name ?? row.original.actor.id ?? "System"}
          />
        ),
      },
      {
        accessorKey: "action",
        header: "Event",
        cell: ({ row }) => (
          <>
            <span className="font-mono text-sm font-medium">{row.original.action}</span>
            <span className="text-muted-foreground mt-1 block text-xs md:hidden">
              {row.original.actor.name ??
                row.original.actor.email ??
                row.original.actor.id ??
                "System"}
            </span>
          </>
        ),
      },
      {
        id: "target",
        header: "Target",
        cell: ({ row }) => (
          <>
            <span
              className="block truncate"
              title={row.original.target.name ?? row.original.target.id}
            >
              {row.original.target.name ?? row.original.target.id}
            </span>
            <span className="text-muted-foreground text-xs">{row.original.target.type}</span>
          </>
        ),
      },
      ...(!workspace
        ? [
            {
              id: "workspace",
              header: "Workspace",
              cell: ({ row }: CellContext<EventTrailEvent, unknown>) => (
                <span
                  className="block truncate"
                  title={row.original.workspace?.name ?? row.original.workspace?.id}
                >
                  {row.original.workspace?.name ?? row.original.workspace?.id ?? "Organization"}
                </span>
              ),
            } satisfies ColumnDef<EventTrailEvent>,
          ]
        : []),
      {
        accessorKey: "result",
        header: "Result",
        cell: ({ row }) => <ResultBadge result={row.original.result} />,
      },
    ],
    [actorImages, workspace]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    columns,
    data: eventTrail.events,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <Sheet open={selected !== undefined} onOpenChange={(open) => !open && setSelected(undefined)}>
      <div className="flex min-w-0 flex-col">
        <AdministrationPageHeader title="Event trail" />
        <EventTrailFilters
          actorImages={actorImages}
          filters={filters}
          hideWorkspace={Boolean(workspace)}
          options={eventTrail.filter_options}
        />
        <EventsChart data={chart} />
        <AdminDataGrid
          ariaLabel={
            workspace ? `${workspace.name} event trail events` : "Organization event trail events"
          }
          emptyState={<p className="text-muted-foreground py-8 text-center">No events found.</p>}
          layout={layout}
          onRowActivate={setSelected}
          pagination={
            <TokenTablePagination
              hasNextPage={Boolean(eventTrail.next_page_token)}
              nextPageToken={eventTrail.next_page_token}
            />
          }
          rowAriaLabel={(event) => `View event trail event: ${event.action}`}
          rows={eventTrail.events}
          table={table}
        />
      </div>
      <SheetContent className="gap-0 overflow-hidden p-0 sm:w-[35rem]! sm:max-w-none!">
        <SheetTitle className="sr-only">Event trail event</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <CodeBlock
              className="min-h-full rounded-none border-0 [&>div]:overflow-y-visible"
              code={JSON.stringify(selected, null, 2)}
              language="json"
              showLineNumbers
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
