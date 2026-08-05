import { AuditEventDetail } from "../audit-event"

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
      params: {
        catchAll: ["audit", "sample-event"],
        eventId: "sample-event",
        orgSlug: "sample-organisation",
      },
    },
  ],
}

export default async function AuditEventPage({
  params,
}: {
  params: Promise<{ eventId: string; orgSlug: string }>
}) {
  const { eventId, orgSlug } = await params
  return <AuditEventDetail eventId={eventId} orgSlug={orgSlug} />
}
