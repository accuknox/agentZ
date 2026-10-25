import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { z } from "zod"
import { AdministrationState } from "@/components/administration"
import {
  listGuardrailConnectionsQuery,
  listGuardrailPoliciesQuery,
  getGuardrailSettingsQuery,
} from "@/data/guardrail.queries"
import {
  getGuardrailEvent,
  listGuardrailEvents,
  type ResourceCapabilities,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { zGuardrailRuntimeEvaluation } from "@/lib/gateway/client/zod.gen"
import {
  GuardrailPolicyList,
  GuardrailConnectionList,
  GuardrailRolloutRefresh,
} from "./resource-list"
import { PolicyEditor } from "./policy-editor"
import { GuardrailOrganizationSettings } from "./settings"
import { GuardrailEvents, GuardrailEventDetail } from "./events"

type GuardrailsPageProps = {
  basePath: `/orgs/${string}/guardrails`
  canAdminister: boolean
  connectionCapabilities: ResourceCapabilities
  eventCapabilities: ResourceCapabilities
  policyCapabilities: ResourceCapabilities
  view: string[]
  searchParams: Record<string, string | string[] | undefined>
  workspaceId?: string
}

export async function GuardrailsPage(props: GuardrailsPageProps) {
  const {
    basePath,
    canAdminister,
    connectionCapabilities,
    eventCapabilities,
    policyCapabilities,
    view,
    searchParams,
    workspaceId,
  } = props

  let defaultSection = "events"
  if (connectionCapabilities.read) defaultSection = "connections"
  if (policyCapabilities.read) defaultSection = "policies"
  const section = view[0] ?? defaultSection
  if (!["policies", "connections", "events", "settings"].includes(section) || view.length > 2)
    notFound()
  if (section !== "policies" && section !== "events" && view.length > 1) notFound()
  const scope = { workspaceId }

  if (section === "events") {
    if (!eventCapabilities.read) return <AdministrationState kind="forbidden" />
    const client = getGatewayServerClient(workspaceId)
    const headers = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined
    if (view[1]) {
      const result = await getGuardrailEvent({ client, headers, path: { eventId: view[1] } })
      if (result.error)
        return (
          <AdministrationState
            description={result.error.message}
            kind="not-found"
            title="Event unavailable"
          />
        )
      return <GuardrailEventDetail basePath={basePath} event={result.data} />
    }

    const action = zGuardrailRuntimeEvaluation.shape.action.safeParse(searchParams.action)
    const traceId = z.string().optional().safeParse(searchParams.trace_id)
    const cursor = z.string().optional().safeParse(searchParams.cursor)
    const result = await listGuardrailEvents({
      client,
      headers,
      query: {
        limit: 25,
        action: action.success ? action.data : undefined,
        trace_id: traceId.success ? traceId.data || undefined : undefined,
        cursor: cursor.success ? cursor.data : undefined,
      },
    })
    if (result.error)
      return (
        <AdministrationState
          description={result.error.message}
          kind="failed"
          title="Could not load guardrail events"
        />
      )
    return (
      <GuardrailEvents
        action={action.success ? action.data : undefined}
        basePath={basePath}
        data={result.data}
        traceId={traceId.success ? traceId.data : undefined}
      />
    )
  }

  const canRead = section === "connections" ? connectionCapabilities.read : policyCapabilities.read
  if (!canRead) return <AdministrationState kind="forbidden" />
  if (section === "settings" && (workspaceId || !canAdminister))
    return <AdministrationState kind="forbidden" />
  const needsConnections =
    connectionCapabilities.read && (section === "connections" || section === "policies")
  const needsPolicies = section !== "connections"
  const needsSettings =
    section === "settings" ||
    (workspaceId !== undefined && section === "policies" && view[1] === undefined)
  const [connectionResult, policyResult, settingsResult] = await Promise.all([
    needsConnections ? listGuardrailConnectionsQuery(workspaceId) : Promise.resolve(undefined),
    needsPolicies ? listGuardrailPoliciesQuery(workspaceId) : Promise.resolve(undefined),
    needsSettings ? getGuardrailSettingsQuery(workspaceId) : Promise.resolve(undefined),
  ])
  const error = connectionResult?.error ?? policyResult?.error ?? settingsResult?.error
  if (error)
    return (
      <AdministrationState
        description={error.message}
        kind="failed"
        title="Could not load guardrails"
      />
    )
  const connections = connectionResult?.data?.items ?? []
  const policies = policyResult?.data?.items ?? []
  const settings = settingsResult?.data
  let content: ReactNode = (
    <GuardrailConnectionList
      canCreate={connectionCapabilities.create}
      connections={connections}
      scope={scope}
    />
  )
  if (section === "policies") {
    content = (
      <GuardrailPolicyList
        canCreate={policyCapabilities.create}
        canCreateConnection={connectionCapabilities.create}
        connections={connections}
        policies={policies}
        scope={scope}
      />
    )
    if (view[1]) {
      const selectedScope = searchParams.scope
      const policy = policies.find(
        (item) => item.name === view[1] && (!selectedScope || item.scope === selectedScope)
      )
      if (view[1] === "new" && !policyCapabilities.create)
        return <AdministrationState kind="forbidden" />
      if (view[1] !== "new" && !policy) notFound()
      content = (
        <>
          {content}
          <PolicyEditor
            basePath={basePath}
            canCreateConnection={connectionCapabilities.create}
            connections={connections}
            key={`${view[1]}/${policy?.scope ?? "new"}`}
            policy={policy}
            scope={scope}
          />
        </>
      )
    }
  }
  if (section === "settings" && settings)
    content = (
      <GuardrailOrganizationSettings
        canModify={canAdminister}
        initial={settings}
        policies={policies}
      />
    )

  return (
    <>
      {workspaceId && settings && settings.mandatoryPolicies.length > 0 ? (
        <div className="px-4 md:px-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {settings.mandatoryPolicies.length} required organization{" "}
              {settings.mandatoryPolicies.length === 1
                ? "policy applies automatically."
                : "policies apply automatically."}
            </span>
          </div>
        </div>
      ) : null}
      <GuardrailRolloutRefresh
        pending={
          connections.some((item) => item.status.state === "Pending") ||
          policies.some((item) => item.status.state === "Pending")
        }
      />
      {content}
    </>
  )
}
