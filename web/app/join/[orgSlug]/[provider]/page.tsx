import type { Route } from "next"
import { eq } from "drizzle-orm"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"

export default async function JoinOrganizationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; provider: string }>
}) {
  return (
    <Suspense fallback={<JoinOrganizationShell />}>
      <JoinOrganizationContent params={params} />
    </Suspense>
  )
}

async function JoinOrganizationContent({
  params,
}: {
  params: Promise<{ orgSlug: string; provider: string }>
}) {
  const { orgSlug, provider } = await params
  if (provider !== "github" && provider !== "google") {
    notFound()
  }

  const [organization] = await getDB()
    .select({ id: schema.organizations.id, slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug))
    .limit(1)
  if (!organization) {
    notFound()
  }

  const result = await getAuth().api.signInSocial({
    body: {
      additionalData: {
        agentzEnrollment: "social",
        organizationId: organization.id,
        provider,
      },
      callbackURL: `/orgs/${organization.slug}`,
      disableRedirect: true,
      errorCallbackURL: `/join/${organization.slug}/${provider}`,
      provider,
      requestSignUp: true,
    },
    headers: await headers(),
  })
  if (!result.url) {
    redirect("/signin?error=no_callback_url")
  }

  redirect(result.url as Route)
  return null
}

function JoinOrganizationShell() {
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Join Organisation</CardTitle>
          <CardDescription>Preparing social admission.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}
