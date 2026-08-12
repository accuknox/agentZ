import type { Route } from "next"
import { z } from "zod"
import { AdministrationPageHeader } from "@/components/administration"
import { RoutedTableRow } from "@/components/routed-table-row"
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
  EventTrailFilters,
  ListEventTrailEventsData,
} from "@/lib/gateway/client"
import {
  zEventTrailActorIdQuery,
  zEventTrailActorTypeQuery,
  zEventTrailCategoryQuery,
  zEventTrailCreatedAfterQuery,
  zEventTrailCreatedBeforeQuery,
  zEventTrailResultQuery,
  zEventTrailTargetTypeQuery,
  zEventTrailWorkspaceIdQuery,
  zPageTokenQuery,
} from "@/lib/gateway/client/zod.gen"
import { formatAge } from "@/lib/format"
import { EventTrailFiltersBar } from "./event-trail-filters"
import { ResultBadge } from "./event-trail-event"
import { EventTrailPagination } from "./event-trail-pagination"

export const eventTrailQuerySchema = z.object({
  actor_type: zEventTrailActorTypeQuery.optional(),
  actor_id: zEventTrailActorIdQuery.optional(),
  category: zEventTrailCategoryQuery.optional(),
  workspace_id: zEventTrailWorkspaceIdQuery.optional(),
  target_type: zEventTrailTargetTypeQuery.optional(),
  result: zEventTrailResultQuery.optional(),
  created_after: zEventTrailCreatedAfterQuery.optional(),
  created_before: zEventTrailCreatedBeforeQuery.optional(),
  page_token: zPageTokenQuery.optional(),
  token_stack: z.string().optional(),
})

export type EventTrailQuery = NonNullable<ListEventTrailEventsData["query"]>

export function EventTrailEvents({
  eventTrail,
  basePath,
  query,
  workspace,
}: {
  eventTrail: { events: EventTrailEvent[]; filters: EventTrailFilters; next_page_token: string }
  basePath: string
  query: EventTrailQuery
  workspace?: { id: string; name: string }
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Event Trail" />
      <EventTrailFiltersBar
        filters={eventTrail.filters}
        hideWorkspace={Boolean(workspace)}
        selected={{
          actorType: query.actor_type,
          actorId: query.actor_id,
          category: query.category,
          workspaceId: workspace?.id ?? query.workspace_id,
          targetType: query.target_type,
          result: query.result,
          createdAfter: query.created_after,
          createdBefore: query.created_before,
        }}
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
                <RoutedTableRow
                  aria-label={`View event trail event: ${event.action}`}
                  data-event-trail-event-id={event.id}
                  href={`${basePath}/${event.id}` as Route}
                  key={event.id}
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
                </RoutedTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={workspace ? 5 : 6}>
                  No eventTrail events
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
  )
}
