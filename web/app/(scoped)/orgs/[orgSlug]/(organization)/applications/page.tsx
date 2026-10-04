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
  const [clients, [setting]] = await Promise.all([
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
      .select()
      .from(schema.organizationDelegation)
      .where(eq(schema.organizationDelegation.organizationId, result.organization.id)),
  ])
  return (
    <Applications
      organization={result.organization}
      clients={clients}
      delegationEnabled={setting?.enabled ?? false}
    />
  )
}
