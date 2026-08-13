"use client"

import { useState } from "react"
import { AdministrationPageHeader } from "@/components/administration"
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
import { EventTrailPagination } from "./event-trail-pagination"

export function EventTrailEvents({
  eventTrail,
  filters,
  workspace,
}: {
  eventTrail: ListEventTrailEventsResponse
  filters: EventTrailFilter[]
  workspace?: { name: string }
}) {
  const [selected, setSelected] = useState<EventTrailEvent>()

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
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead className="hidden md:table-cell">Actor</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Target</TableHead>
                {!workspace ? (
                  <TableHead className="hidden lg:table-cell">Workspace</TableHead>
                ) : null}
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eventTrail.events.length ? (
                eventTrail.events.map((event) => (
                  <TableRow
                    aria-label={`View event trail event: ${event.action}`}
                    className="focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:ring-inset"
                    key={event.id}
                    onClick={() => setSelected(event)}
                    onKeyDown={(keyboardEvent) => {
                      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return
                      keyboardEvent.preventDefault()
                      setSelected(event)
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <TableCell className="min-w-36">
                      <time className="text-muted-foreground text-xs" dateTime={event.created_at}>
                        {formatAge(event.created_at)}
                      </time>
                    </TableCell>
                    <TableCell className="hidden max-w-56 md:table-cell">
                      <span
                        className="block truncate"
                        title={event.actor.name ?? event.actor.email ?? event.actor.id}
                      >
                        {event.actor.name ?? event.actor.email ?? event.actor.id ?? "System"}
                      </span>
                      <span className="text-muted-foreground text-xs">{event.actor.type}</span>
                    </TableCell>
                    <TableCell className="min-w-48">
                      <span className="font-mono text-sm font-medium">{event.action}</span>
                      <span className="text-muted-foreground mt-1 block text-xs md:hidden">
                        {event.actor.name ?? event.actor.email ?? event.actor.id ?? "System"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="block truncate" title={event.target.name ?? event.target.id}>
                        {event.target.name ?? event.target.id}
                      </span>
                      <span className="text-muted-foreground text-xs">{event.target.type}</span>
                    </TableCell>
                    {!workspace ? (
                      <TableCell className="hidden max-w-56 lg:table-cell">
                        <span
                          className="block truncate"
                          title={event.workspace?.name ?? event.workspace?.id}
                        >
                          {event.workspace?.name ?? event.workspace?.id ?? "Organisation"}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <ResultBadge result={event.result} />
                    </TableCell>
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
          {eventTrail.events.length ? (
            <div className="py-3">
              <EventTrailPagination nextPageToken={eventTrail.next_page_token} />
            </div>
          ) : null}
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
