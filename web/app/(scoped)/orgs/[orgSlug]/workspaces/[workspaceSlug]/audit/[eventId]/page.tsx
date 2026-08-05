import { AuditEventDetail } from "@/app/(scoped)/orgs/[orgSlug]/(organization)/audit/audit-event"

export const unstable_instant = false

export default async function WorkspaceAuditEventPage({
  params,
}: {
  params: Promise<{ eventId: string; orgSlug: string; workspaceSlug: string }>
}) {
  const { eventId, orgSlug, workspaceSlug } = await params
  return <AuditEventDetail eventId={eventId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
}
