import type { Route } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { getOrganizationAuditEvent } from "@/data/audit"
import { formatTimestampWithAge } from "@/lib/format"
import type { AuditField, AuditResult } from "@/lib/gateway/client"

export async function AuditEventDetail({ eventId }: { eventId: string }) {
  const result = await getOrganizationAuditEvent(eventId)
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

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ResultBadge result={event.result} />
          <Badge variant="outline">{event.category}</Badge>
          <Badge variant="secondary">{event.interface}</Badge>
        </div>
        <h2 className="font-mono text-xl font-semibold break-all">{event.action}</h2>
        <time className="text-muted-foreground text-sm" dateTime={event.created_at}>
          {formatTimestampWithAge(event.created_at)}
        </time>
      </header>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <AuditFields title="Before" fields={event.before} />
        <AuditFields title="After" fields={event.after} />
      </div>

      {(event.ip_address || event.user_agent) && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Request</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {event.ip_address ? (
                <DetailTerm label="IP address" value={event.ip_address} mono />
              ) : null}
              {event.user_agent ? <DetailTerm label="User agent" value={event.user_agent} /> : null}
            </dl>
          </CardContent>
        </Card>
      )}

      <Card size="sm">
        <CardHeader>
          <CardTitle>Cascade and cleanup</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <DetailTerm label="Automatic cascade" value={event.automatic_cascade ? "Yes" : "No"} />
            <DetailTerm label="Cleanup status" value={event.cleanup?.state ?? "Not applicable"} />
            {event.cleanup ? (
              <DetailTerm label="Cleanup job" value={event.cleanup.id} mono />
            ) : null}
            {event.cleanup?.completed_at ? (
              <DetailTerm
                label="Cleanup completed"
                value={formatTimestampWithAge(event.cleanup.completed_at)}
              />
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </article>
  )
}

function AuditFields({ title, fields }: { title: string; fields: AuditField[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {fields.length ? (
          <dl className="grid gap-3">
            {fields.map((field, index) => (
              <div key={`${field.field}-${index}`}>
                {index ? <Separator className="mb-3" /> : null}
                <dt className="text-muted-foreground font-mono text-xs">{field.field}</dt>
                <dd className="mt-1 break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">No recorded fields.</p>
        )}
      </CardContent>
    </Card>
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

export function ResultBadge({ result }: { result: AuditResult }) {
  if (result === "succeeded") return <Badge variant="success">Succeeded</Badge>
  if (result === "denied") return <Badge variant="warning">Denied</Badge>
  return <Badge variant="destructive">Failed</Badge>
}
