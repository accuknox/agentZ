"use client"

import { useMemo, useState } from "react"
import {
  type CellContext,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { AdministrationPageHeader } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  EventTrailEvent,
  EventTrailFilter,
  ListEventTrailEventsResponse,
} from "@/lib/gateway/client"
import { formatAge } from "@/lib/format"
import { ResultBadge } from "./event-trail-event"
import { EventTrailFilters } from "./event-trail-filters"

export function EventTrailEvents({
  eventTrail,
  filters,
  workspace,
}: {
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
        cell: ({ row }) => (
          <time className="text-muted-foreground text-xs" dateTime={row.original.created_at}>
            {formatAge(row.original.created_at)}
          </time>
        ),
      },
      {
        id: "actor",
        header: "Actor",
        cell: ({ row }) => (
          <>
            <span
              className="block truncate"
              title={row.original.actor.name ?? row.original.actor.email ?? row.original.actor.id}
            >
              {row.original.actor.name ??
                row.original.actor.email ??
                row.original.actor.id ??
                "System"}
            </span>
            <span className="text-muted-foreground text-xs">{row.original.actor.type}</span>
          </>
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
                  {row.original.workspace?.name ?? row.original.workspace?.id ?? "Organisation"}
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
    [workspace]
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
        <AdministrationPageHeader title="Event Trail" />
        <EventTrailFilters
          filters={filters}
          hideWorkspace={Boolean(workspace)}
          options={eventTrail.filter_options}
        />
        <div className="w-full min-w-0 border-b">
          <Table
            aria-label={
              workspace ? `${workspace.name} event trail events` : "Organisation event trail events"
            }
          >
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead
                      className={
                        header.column.id === "actor"
                          ? "hidden md:table-cell"
                          : header.column.id === "workspace"
                            ? "hidden lg:table-cell"
                            : undefined
                      }
                      key={header.id}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    aria-label={`View event trail event: ${row.original.action}`}
                    className="focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:ring-inset"
                    key={row.id}
                    onClick={() => setSelected(row.original)}
                    onKeyDown={(keyboardEvent) => {
                      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return
                      keyboardEvent.preventDefault()
                      setSelected(row.original)
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        className={
                          cell.column.id === "created_at"
                            ? "min-w-36"
                            : cell.column.id === "actor"
                              ? "hidden max-w-56 md:table-cell"
                              : cell.column.id === "action"
                                ? "min-w-48"
                                : cell.column.id === "workspace"
                                  ? "hidden max-w-56 lg:table-cell"
                                  : cell.column.id === "target"
                                    ? "max-w-56"
                                    : undefined
                        }
                        key={cell.id}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="h-24 text-center" colSpan={workspace ? 5 : 6}>
                    No events found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="py-3">
            <TokenTablePagination
              hasNextPage={Boolean(eventTrail.next_page_token)}
              nextPageToken={eventTrail.next_page_token}
            />
          </div>
        </div>
      </div>
      <SheetContent className="gap-0 overflow-hidden p-0 sm:w-[35rem]! sm:max-w-none!">
        <SheetTitle className="sr-only">Event Trail event</SheetTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <CodeBlock
              className="min-h-full rounded-none border-0 [&>div]:overflow-x-auto [&>div]:overflow-y-visible"
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
