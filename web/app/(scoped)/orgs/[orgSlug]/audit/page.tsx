import type { Route } from "next"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { z } from "zod"
import { AdministrationState } from "@/components/administration"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listOrganizationAuditEvents } from "@/data/audit"
import type { ListAuditEventsData } from "@/lib/gateway/client"
import {
  zAuditActorIdQuery,
  zAuditActorTypeQuery,
  zAuditCategoryQuery,
  zAuditCreatedAfterQuery,
  zAuditCreatedBeforeQuery,
  zAuditResultQuery,
  zAuditTargetTypeQuery,
  zAuditWorkspaceIdQuery,
  zPageTokenQuery,
} from "@/lib/gateway/client/zod.gen"
import { formatTimestampWithAge } from "@/lib/format"
import { AuditFiltersBar } from "./audit-filters"
import { ResultBadge } from "./audit-event"
import { AuditPagination } from "./audit-pagination"

export const unstable_instant = {
  prefetch: "runtime",
  // A build cannot carry a stable authenticated session; live requests retain
  // development validation against the real Organisation boundary.
  unstable_disableBuildValidation: true,
  samples: [
    {
      cookies: [],
      headers: [
        ["next-action", null],
        ["rsc", null],
        ["x-agentz-pathname", null],
      ],
      params: { catchAll: ["audit"], orgSlug: "sample-organisation" },
      searchParams: {
        actor_id: null,
        actor_type: null,
        category: null,
        created_after: null,
        created_before: null,
        page_token: null,
        result: null,
        target_type: null,
        workspace_id: null,
      },
    },
  ],
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug }, raw] = await Promise.all([params, searchParams])
  const filters = z
    .object({
      actor_type: zAuditActorTypeQuery.optional(),
      actor_id: zAuditActorIdQuery.optional(),
      category: zAuditCategoryQuery.optional(),
      workspace_id: zAuditWorkspaceIdQuery.optional(),
      target_type: zAuditTargetTypeQuery.optional(),
      result: zAuditResultQuery.optional(),
      created_after: zAuditCreatedAfterQuery.optional(),
      created_before: zAuditCreatedBeforeQuery.optional(),
      page_token: zPageTokenQuery.optional(),
      token_stack: z.string().optional(),
    })
    .parse(raw)
  const query = {
    ...filters,
    limit: 50,
  } satisfies NonNullable<ListAuditEventsData["query"]>
  const audit = await listOrganizationAuditEvents(query)

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Alert role="note">
        <ShieldCheck aria-hidden="true" />
        <AlertTitle>Rolling 30-day audit history</AlertTitle>
        <AlertDescription>
          Audit events are retained for 30 days. Organisation events remain available for that
          period after a Workspace is deleted.
        </AlertDescription>
      </Alert>
      <AuditFiltersBar
        filters={audit.filters}
        selected={{
          actorType: query.actor_type,
          actorId: query.actor_id,
          category: query.category,
          workspaceId: query.workspace_id,
          targetType: query.target_type,
          result: query.result,
          createdAfter: query.created_after,
          createdBefore: query.created_before,
        }}
      />
      {audit.events.length ? (
        <Card>
          <CardContent className="px-0">
            <Table aria-label="Organisation audit events">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead className="hidden md:table-cell">Actor</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="hidden lg:table-cell">Workspace</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="min-w-36 align-top">
                      <time className="text-muted-foreground text-xs" dateTime={event.created_at}>
                        {formatTimestampWithAge(event.created_at)}
                      </time>
                    </TableCell>
                    <TableCell className="hidden max-w-56 align-top md:table-cell">
                      <span
                        className="block truncate"
                        title={event.actor.name ?? event.actor.email ?? event.actor.id}
                      >
                        {event.actor.name ?? event.actor.email ?? event.actor.id ?? "System"}
                      </span>
                      <span className="text-muted-foreground text-xs">{event.actor.type}</span>
                    </TableCell>
                    <TableCell className="min-w-48 align-top">
                      <Link
                        aria-label={`View audit event: ${event.action}`}
                        className="font-mono text-sm font-medium underline-offset-4 hover:underline"
                        data-audit-event-id={event.id}
                        href={`/orgs/${orgSlug}/audit/${event.id}` as Route}
                        scroll={false}
                      >
                        {event.action}
                      </Link>
                      <span className="text-muted-foreground mt-1 block text-xs md:hidden">
                        {event.actor.name ?? event.actor.email ?? event.actor.id ?? "System"}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56 align-top">
                      <span className="block truncate" title={event.target.name ?? event.target.id}>
                        {event.target.name ?? event.target.id}
                      </span>
                      <span className="text-muted-foreground text-xs">{event.target.type}</span>
                    </TableCell>
                    <TableCell className="hidden max-w-56 align-top lg:table-cell">
                      <span
                        className="block truncate"
                        title={event.workspace?.name ?? event.workspace?.id}
                      >
                        {event.workspace?.name ?? event.workspace?.id ?? "Organisation"}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      <ResultBadge result={event.result} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter className="border-t py-3">
            <AuditPagination nextPageToken={audit.next_page_token} />
          </CardFooter>
        </Card>
      ) : (
        <AdministrationState
          description="No events match this period and filter set."
          kind="empty"
          title="No audit events"
        />
      )}
    </div>
  )
}
