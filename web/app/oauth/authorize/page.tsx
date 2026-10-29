import { Suspense } from "react"
import { redirect } from "next/navigation"
import { and, asc, eq, isNull } from "drizzle-orm"
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"
import { getDB, schema } from "@/db"
import { getAuthSession } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import {
  delegationCatalog,
  delegationRequest,
  externalAgentAccess,
  type DelegationRequest,
} from "@/lib/delegation"
import { Consent, ResumeAuthorization } from "./consent"
import { AuthorizationState } from "./authorization-state"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"

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
            title="Connecting your account"
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
  if (params.get("result") === "approved" || params.get("result") === "denied") {
    const approved = params.get("result") === "approved"
    return (
      <AuthorizationState
        title={approved ? "Application connected" : "Access declined"}
        description="Return to your terminal to continue."
      />
    )
  }
  if (!oauthQuery)
    return (
      <form action="/oauth/authorize" className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold">Connect an application</h1>
        <Field>
          <FieldLabel htmlFor="device-user-code">Code from your terminal</FieldLabel>
          <Input
            id="device-user-code"
            name="user_code"
            required
            autoComplete="off"
            maxLength={191}
          />
        </Field>
        <Button type="submit">Review connection</Button>
      </form>
    )
  const userCode = params.get("user_code")
  let request: DelegationRequest = { type: "authorization_code", oauthQuery }
  if (userCode !== null)
    request = { type: "device_code", userCode: userCode.replace(/[^a-z0-9]/gi, "").toUpperCase() }
  if (
    request.type === "authorization_code" &&
    !(await verifyOAuthQueryParams(oauthQuery, getEnv().BETTER_AUTH_SECRET))
  )
    return expiredRequest
  const session = await getAuthSession()
  if (!session) {
    if (request.type === "device_code")
      redirect(
        `/signin?returnTo=${encodeURIComponent(`/oauth/authorize?user_code=${request.userCode}`)}`
      )
    redirect(`/signin?${oauthQuery}`)
  }
  if (request.type === "authorization_code" && !params.has("agentz_tx"))
    redirect(`/signin?${oauthQuery}`)
  const transaction = await delegationRequest(
    request,
    session.session.user.id,
    session.session.session.id
  ).catch(() => undefined)
  if (!transaction) return expiredRequest
  const [client] = await getDB()
    .select({
      name: schema.oauthClients.name,
      disabled: schema.oauthClients.disabled,
      owner: schema.organizations.name,
      agent: schema.externalAgents,
    })
    .from(schema.oauthClients)
    .leftJoin(schema.organizations, eq(schema.organizations.id, schema.oauthClients.referenceId))
    .leftJoin(
      schema.externalAgents,
      eq(schema.externalAgents.clientId, schema.oauthClients.clientId)
    )
    .where(eq(schema.oauthClients.clientId, transaction.clientId))
  if (
    !client ||
    client.disabled ||
    (client.agent && client.agent.userId !== session.session.user.id)
  )
    return (
      <AuthorizationState
        title="This app is unavailable"
        description="We can no longer connect this application. Contact its owner for help."
      />
    )
  if (
    client.agent &&
    !(await externalAgentAccess(transaction.clientId, session.session.user).catch(() => undefined))
  )
    return (
      <AuthorizationState
        title="Agent access unavailable"
        description="You need Use externally permission in this agent's workspace to continue."
      />
    )
  if (request.type === "authorization_code" && transaction.grantId)
    return <ResumeAuthorization oauthQuery={oauthQuery} />
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
      and(
        eq(schema.members.userId, session.session.user.id),
        isNull(schema.members.disabledAt),
        client.agent ? eq(schema.organizations.id, client.agent.organizationId) : undefined
      )
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
    .where(
      and(
        isNull(schema.workspaces.deletedAt),
        eq(schema.workspaces.state, "ready"),
        client.agent ? eq(schema.workspaces.id, client.agent.workspaceId) : undefined
      )
    )
    .orderBy(asc(schema.workspaces.name))
  return (
    <Consent
      initialWorkspace={
        client.agent && organizations.length && workspaces.length
          ? {
              id: client.agent.workspaceId,
              catalog: await delegationCatalog(
                client.agent.organizationId,
                client.agent.workspaceId,
                session.session.user
              ),
            }
          : undefined
      }
      request={request}
      client={{
        name: client.name ?? "Application",
        owner: client.owner,
        callback: request.type === "authorization_code" ? (params.get("redirect_uri") ?? "") : "",
        agent: client.agent?.kind,
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
