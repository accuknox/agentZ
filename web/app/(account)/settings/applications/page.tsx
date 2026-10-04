import { Suspense, type ComponentProps } from "react"
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { AdministrationLoadingState, AdministrationPageHeader } from "@/components/administration"
import { getAuthSession } from "@/lib/auth"
import { getDB, schema } from "@/db"
import { ConnectedApplications } from "./connected-applications"

export const metadata = { title: "Connected applications" }

export default function ConnectedApplicationsPage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader
        title="Connected applications"
        description="Review the applications you've connected to AgentZ and revoke their access."
      />
      <Suspense fallback={<AdministrationLoadingState />}>
        <ConnectedApplicationsContent />
      </Suspense>
    </main>
  )
}

async function ConnectedApplicationsContent() {
  const session = await getAuthSession()
  if (!session) return null
  const resourceOrganizations = alias(schema.organizations, "resource_organizations")
  const rows = await getDB()
    .select({
      clientId: schema.oauthClients.clientId,
      name: schema.oauthClients.name,
      owner: schema.organizations.name,
      organization: resourceOrganizations.name,
      scopes: schema.delegationGrants.scopes,
      selection: schema.delegationGrants.selection,
      createdAt: schema.delegationGrants.createdAt,
    })
    .from(schema.delegationGrants)
    .innerJoin(
      schema.oauthClients,
      eq(schema.oauthClients.clientId, schema.delegationGrants.clientId)
    )
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.oauthClients.referenceId))
    .leftJoin(
      resourceOrganizations,
      eq(resourceOrganizations.id, schema.delegationGrants.organizationId)
    )
    .where(
      and(
        eq(schema.delegationGrants.userId, session.session.user.id),
        isNull(schema.delegationGrants.revokedAt),
        isNotNull(schema.delegationGrants.approvedAt)
      )
    )
    .orderBy(desc(schema.delegationGrants.createdAt))
  const grouped = new Map<
    string,
    ComponentProps<typeof ConnectedApplications>["applications"][number]
  >()
  for (const row of rows) {
    const current = grouped.get(row.clientId) ?? {
      clientId: row.clientId,
      name: row.name ?? "Application",
      owner: row.owner,
      scopes: [],
      grants: [],
      createdAt: row.createdAt.toISOString(),
    }
    current.scopes = [...new Set([...current.scopes, ...row.scopes])]
    current.grants.push({ organization: row.organization, selection: row.selection })
    grouped.set(row.clientId, current)
  }
  const workspaceIds = [
    ...new Set(
      rows.flatMap((row) =>
        [...row.selection.models, ...row.selection.mcp].map((item) => item.workspace_id)
      )
    ),
  ]
  const workspaces = workspaceIds.length
    ? await getDB()
        .select({ id: schema.workspaces.id, name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(inArray(schema.workspaces.id, workspaceIds))
    : []
  return (
    <ConnectedApplications
      applications={[...grouped.values()]}
      workspaces={Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name]))}
    />
  )
}
