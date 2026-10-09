import { Suspense } from "react"
import { asc, eq } from "drizzle-orm"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { resolveOrganizationSlug } from "@/data/organizations"
import { getDB, schema } from "@/db"
import { Applications } from "./applications"

export const metadata = { title: "Applications" }

export default function ApplicationsPage(props: PageProps<"/orgs/[orgSlug]/applications">) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <ApplicationsContent {...props} />
    </Suspense>
  )
}

async function ApplicationsContent({ params }: PageProps<"/orgs/[orgSlug]/applications">) {
  const { orgSlug } = await params
  const result = await resolveOrganizationSlug(orgSlug)
  if (result.kind !== "ready") return null
  if (!result.organization.superadmin) return <AdministrationState kind="forbidden" />
  const [clients, [setting], origins] = await Promise.all([
    getDB()
      .select({
        clientId: schema.oauthClients.clientId,
        name: schema.oauthClients.name,
        redirectUris: schema.oauthClients.redirectUris,
        scopes: schema.oauthClients.scopes,
        tokenEndpointAuthMethod: schema.oauthClients.tokenEndpointAuthMethod,
        applicationType: schema.oauthClients.applicationType,
        disabled: schema.oauthClients.disabled,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.referenceId, result.organization.id))
      .orderBy(asc(schema.oauthClients.createdAt)),
    getDB()
      .select({ enabled: schema.organizationDelegation.enabled })
      .from(schema.organizationDelegation)
      .where(eq(schema.organizationDelegation.organizationId, result.organization.id)),
    getDB()
      .select({
        clientId: schema.oauthClientOrigins.clientId,
        origin: schema.oauthClientOrigins.origin,
      })
      .from(schema.oauthClientOrigins)
      .innerJoin(
        schema.oauthClients,
        eq(schema.oauthClients.clientId, schema.oauthClientOrigins.clientId)
      )
      .where(eq(schema.oauthClients.referenceId, result.organization.id))
      .orderBy(asc(schema.oauthClientOrigins.origin)),
  ])
  return (
    <Applications
      organizationId={result.organization.id}
      clients={clients.map((client) => ({
        ...client,
        authorizedOrigins: origins
          .filter((entry) => entry.clientId === client.clientId)
          .map((entry) => entry.origin),
      }))}
      delegationEnabled={setting?.enabled ?? false}
    />
  )
}
