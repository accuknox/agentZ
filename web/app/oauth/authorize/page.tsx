import { Suspense } from "react"
import Image from "next/image"
import { redirect } from "next/navigation"
import { and, asc, eq, isNull } from "drizzle-orm"
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { delegationTransaction } from "@/lib/delegation"
import { Consent, ResumeAuthorization } from "./consent"

export const metadata = { title: "Authorize application", robots: { index: false, follow: false } }

export default function AuthorizePage(props: PageProps<"/oauth/authorize">) {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-8 px-5 py-10 sm:px-8"
    >
      <div className="flex items-center gap-2.5">
        <Image src="/agentz-logo.svg" alt="" width={35} height={30} />
        <span className="text-2xl font-semibold tracking-tight">AgentZ</span>
      </div>
      <Suspense
        fallback={
          <p role="status" className="text-muted-foreground">
            Loading authorization request…
          </p>
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
    <div role="alert" className="space-y-2 rounded-lg border p-6">
      <h1 className="text-xl font-semibold">This request has expired</h1>
      <p className="text-sm text-muted-foreground">
        Return to the application and start Sign in with AgentZ again.
      </p>
    </div>
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
      <p role="alert">This application is unavailable. Return to the application to continue.</p>
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
        callback:
          new URL(params.get("redirect_uri") ?? "").host || params.get("redirect_uri") || "",
      }}
      user={{ name: session.session.user.name, email: session.session.user.email }}
      scopes={transaction.scopes}
      organizations={organizations}
      workspaces={workspaces}
    />
  )
}
