import { EventTrailEventDetail } from "../event-trail-event"

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
        catchAll: ["event trail", "sample-event"],
        eventId: "sample-event",
        orgSlug: "sample-organisation",
      },
    },
  ],
}

export default async function EventTrailEventPage({
  params,
}: {
  params: Promise<{ eventId: string; orgSlug: string }>
}) {
  const { eventId, orgSlug } = await params
  return <EventTrailEventDetail eventId={eventId} orgSlug={orgSlug} />
}
