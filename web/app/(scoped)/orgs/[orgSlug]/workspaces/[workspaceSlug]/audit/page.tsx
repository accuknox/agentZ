import type { ListAuditEventsData } from "@/lib/gateway/client"
import {
  AuditEvents,
  auditQuerySchema,
} from "@/app/(scoped)/orgs/[orgSlug]/(organization)/audit/audit-events"
import { AdministrationState } from "@/components/administration"
import { listWorkspaceAuditEvents } from "@/data/audit"

export const unstable_instant = false

export default async function WorkspaceAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ orgSlug, workspaceSlug }, raw] = await Promise.all([params, searchParams])
  const filters = auditQuerySchema.parse(raw)
  const query = {
    ...filters,
    limit: 50,
    workspace_id: undefined,
  } satisfies NonNullable<ListAuditEventsData["query"]>
  const result = await listWorkspaceAuditEvents(orgSlug, workspaceSlug, query)
  if (!result) {
    return <AdministrationState kind="forbidden" />
  }

  const basePath = `/orgs/${orgSlug}/workspaces/${workspaceSlug}/audit`
  return (
    <AuditEvents
      audit={result.audit}
      basePath={basePath}
      query={query}
      workspace={result.workspace}
    />
  )
}
