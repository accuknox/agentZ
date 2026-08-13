import type { Route } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { getOrganizationEventTrailEvent, getWorkspaceEventTrailEvent } from "@/data/event-trail"
import { formatAge } from "@/lib/format"
import type { EventTrailField, EventTrailResult } from "@/lib/gateway/client"

export async function EventTrailEventDetail({
  compact,
  eventId,
  orgSlug,
  workspaceSlug,
}: {
  compact?: boolean
  eventId: string
  orgSlug: string
  workspaceSlug?: string
}) {
  const result = workspaceSlug
    ? await getWorkspaceEventTrailEvent(orgSlug, workspaceSlug, eventId)
    : await getOrganizationEventTrailEvent(orgSlug, eventId)
  if (!result) {
    return workspaceSlug ? <AdministrationState kind="forbidden" /> : null
  }
  if (result.error) {
    if (result.response?.status === 404) {
      notFound()
    }
    if (result.response?.status === 403) {
      return <AdministrationState kind="forbidden" />
    }
    throw new Error(result.error.message)
  }

  const event = result.data
  const target =
    event.target.type === "organization" && event.target.slug
      ? (`/orgs/${event.target.slug}/general` as Route)
      : undefined
  const Heading = compact ? "h2" : "h1"

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
          <ResultBadge result={event.result} />
          <span>·</span>
          <span>{event.category}</span>
          <span>·</span>
          <span>{event.interface}</span>
        </div>
        <Heading className="font-mono text-xl font-semibold break-all">{event.action}</Heading>
        <time className="text-muted-foreground text-sm" dateTime={event.created_at}>
          {formatAge(event.created_at)}
        </time>
      </header>

      <section className="space-y-3 border-b pb-4">
        <h3 className="font-medium">Overview</h3>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailTerm
            label="Actor"
            value={event.actor.name ?? event.actor.email ?? event.actor.id ?? "System"}
          />
          <DetailTerm label="Actor type" value={event.actor.type} />
          <DetailTerm label="Target">
            {target ? (
              <Link
                className="text-primary break-words underline-offset-4 hover:underline"
                href={target}
              >
                {event.target.name ?? event.target.id}
              </Link>
            ) : (
              <span className="break-words">{event.target.name ?? event.target.id}</span>
            )}
          </DetailTerm>
          <DetailTerm label="Resource type" value={event.target.type} />
          <DetailTerm
            label="Workspace"
            value={
              event.workspace?.name ??
              event.workspace?.slug ??
              event.workspace?.id ??
              "Organisation"
            }
          />
          <DetailTerm label="Event ID" value={event.id} mono />
        </dl>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <EventTrailFields title="Before" fields={event.before} />
        <EventTrailFields title="After" fields={event.after} />
      </div>

      {(event.ip_address || event.user_agent) && (
        <section className="space-y-3 border-b pb-4">
          <h3 className="font-medium">Request</h3>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {event.ip_address ? (
              <DetailTerm label="IP address" value={event.ip_address} mono />
            ) : null}
            {event.user_agent ? <DetailTerm label="User agent" value={event.user_agent} /> : null}
          </dl>
        </section>
      )}

      <section className="space-y-3 border-b pb-4">
        <h3 className="font-medium">Cascade and cleanup</h3>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailTerm label="Automatic cascade" value={event.automatic_cascade ? "Yes" : "No"} />
          <DetailTerm label="Cleanup status" value={event.cleanup?.state ?? "Not applicable"} />
          {event.cleanup ? <DetailTerm label="Cleanup job" value={event.cleanup.id} mono /> : null}
          {event.cleanup?.completed_at ? (
            <DetailTerm label="Cleanup completed" value={formatAge(event.cleanup.completed_at)} />
          ) : null}
        </dl>
      </section>
    </article>
  )
}

function EventTrailFields({ title, fields }: { title: string; fields: EventTrailField[] }) {
  return (
    <section className="space-y-3 border-b pb-4">
      <h3 className="font-medium">{title}</h3>
      {fields.length ? (
        <dl className="grid gap-3">
          {fields.map((field, index) => (
            <div key={`${field.field}-${index}`}>
              <dt className="text-muted-foreground font-mono text-xs">{field.field}</dt>
              <dd className="mt-1 break-words">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">No recorded fields.</p>
      )}
    </section>
  )
}

function DetailTerm({
  children,
  label,
  mono,
  value,
}: {
  children?: React.ReactNode
  label: string
  mono?: boolean
  value?: string
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className={mono ? "mt-1 font-mono break-all" : "mt-1 break-words"}>
        {children ?? value}
      </dd>
    </div>
  )
}

export function ResultBadge({ result }: { result: EventTrailResult }) {
  if (result === "succeeded") return <Badge variant="success">Succeeded</Badge>
  if (result === "denied") return <Badge variant="warning">Denied</Badge>
  return <Badge variant="destructive">Failed</Badge>
}
