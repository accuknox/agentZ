import { Suspense } from "react"
import { redirect } from "next/navigation"
import { and, asc, eq, isNull } from "drizzle-orm"
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { delegationTransaction } from "@/lib/delegation"
import { Consent, ResumeAuthorization } from "./consent"
import { AuthorizationState } from "./authorization-state"

export const metadata = { title: "Authorize application", robots: { index: false, follow: false } }

export default function AuthorizePage(props: PageProps<"/oauth/authorize">) {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-svh w-full max-w-2xl flex-col justify-center px-6 py-10 md:px-10 md:py-14"
    >
      <Suspense
        fallback={
          <AuthorizationState
            title="Connecting to AgentZ"
            description="Loading the application's access request…"
            pending
          />
        }
      >
        <AuthorizeContent {...props} />
      </Suspense>
    </main>
  )
}

async function AuthorizeContent({ searchParams }: PageProps<"/oauth/authorize">) {
  const search = await searchParams
  const params = new URLSearchParams()
  for (const [key, values] of Object.entries(search)) {
    for (const value of [values].flat()) if (value !== undefined) params.append(key, value)
  }
  const oauthQuery = params.toString()
  const expiredRequest = (
    <AuthorizationState
      title="This connection request expired"
      description="Return to the app you were connecting and reattempt sign in."
    />
  )
  if (!(await verifyOAuthQueryParams(oauthQuery, getEnv().BETTER_AUTH_SECRET)))
    return expiredRequest
  const session = await getAuthSession()
  if (!session) redirect(`/signin?returnTo=${encodeURIComponent(`/oauth/authorize?${oauthQuery}`)}`)
  if (!params.has("agentz_tx")) {
    return <ResumeAuthorization oauthQuery={oauthQuery} />
  }
  const transaction = await delegationTransaction(
    oauthQuery,
    session.session.user.id,
    session.session.session.id
  )
  if (!transaction) return expiredRequest
  const [client] = await getDB()
    .select({
      name: schema.oauthClients.name,
      disabled: schema.oauthClients.disabled,
      owner: schema.organizations.name,
    })
    .from(schema.oauthClients)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.oauthClients.referenceId))
    .where(eq(schema.oauthClients.clientId, transaction.clientId))
  if (!client || client.disabled)
    return (
      <AuthorizationState
        title="This app is unavailable"
        description="This application can no longer connect to AgentZ. Contact the app owner for help."
      />
    )
  if (transaction.grantId) return <ResumeAuthorization oauthQuery={oauthQuery} consent />
  const organizations = await getDB()
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.members)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
    .innerJoin(
      schema.organizationDelegation,
      and(
        eq(schema.organizationDelegation.organizationId, schema.members.organizationId),
        eq(schema.organizationDelegation.enabled, true)
      )
    )
    .where(
      and(eq(schema.members.userId, session.session.user.id), isNull(schema.members.disabledAt))
    )
    .orderBy(asc(schema.organizations.name))
  const workspaces = await getDB()
    .select({
      id: schema.workspaces.id,
      organizationId: schema.workspaces.organizationId,
      name: schema.workspaces.name,
    })
    .from(schema.workspaces)
    .innerJoin(
      schema.members,
      and(
        eq(schema.members.organizationId, schema.workspaces.organizationId),
        eq(schema.members.userId, session.session.user.id),
        isNull(schema.members.disabledAt)
      )
    )
    .where(and(isNull(schema.workspaces.deletedAt), eq(schema.workspaces.state, "ready")))
    .orderBy(asc(schema.workspaces.name))
  return (
    <Consent
      oauthQuery={oauthQuery}
      client={{
        name: client.name ?? "Application",
        owner: client.owner,
        callback: params.get("redirect_uri") ?? "",
      }}
      user={{
        name: session.session.user.name,
        email: session.session.user.email,
        image: session.session.user.image,
      }}
      scopes={transaction.scopes}
      organizations={organizations}
      workspaces={workspaces}
    />
  )
}
