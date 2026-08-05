import type { ListAuditEventsData } from "@/lib/gateway/client"
import { listOrganizationAuditEvents } from "@/data/audit"
import { AuditEvents, auditQuerySchema } from "./audit-events"

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
  const filters = auditQuerySchema.parse(raw)
  const query = { ...filters, limit: 50 } satisfies NonNullable<ListAuditEventsData["query"]>
  const audit = await listOrganizationAuditEvents(orgSlug, query)
  if (!audit) {
    return null
  }

  return <AuditEvents audit={audit} basePath={`/orgs/${orgSlug}/audit`} query={query} />
}
