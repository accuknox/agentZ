import { AuditEventDetail } from "../../../audit/audit-event"
import { AuditDrawer } from "../../audit-drawer"

// Next 16.2 cannot validate runtime samples for intercepted dynamic segments;
// the canonical detail route validates the same server-rendered content.
export const unstable_instant = false

export default async function InterceptedAuditEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return (
    <AuditDrawer>
      <AuditEventDetail eventId={eventId} />
    </AuditDrawer>
  )
}
