import { Suspense, type ReactNode } from "react"
import { EventsChart } from "@/components/events-chart"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { dayjs } from "@/lib/format"
import { notFound, redirect } from "next/navigation"
import { z } from "zod"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import {
  listGuardrailConnectionsQuery,
  listGuardrailPoliciesQuery,
  getGuardrailSettingsQuery,
  listGuardrailEventSourcesQuery,
} from "@/data/guardrail.queries"
import { getWorkspaceDirectory } from "@/data/workspaces"
import {
  getGuardrailEventChart,
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
import { GuardrailEvents } from "./events"
import { GuardrailEventFilters } from "./event-filters"

type GuardrailsPageProps = {
  orgSlug: string
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
    orgSlug,
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
    if (view[1]) redirect(`${basePath}/events?event=${encodeURIComponent(view[1])}`)
    const input = z
      .object({
        action: zGuardrailRuntimeEvaluation.shape.action.optional(),
        phase: zGuardrailRuntimeEvaluation.shape.phase.optional(),
        trace_id: z.string().optional(),
        session_id: z.string().optional(),
        workspace_id: z.string().optional(),
        agent_name: z.string().optional(),
        client_id: z.string().optional(),
        cursor: z.string().optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .safeParse(searchParams)
    if (!input.success)
      return (
        <AdministrationState
          kind="failed"
          title="Invalid event filters"
          description="Check the selected time range and filters."
        />
      )
    const { cursor, ...filters } = input.data
    const to = filters.to ?? dayjs().toISOString()
    const from = filters.from ?? dayjs(to).subtract(24, "hour").toISOString()
    const query = { ...filters, from, to }
    const chart = getGuardrailEventChart({ client, headers, query })
    const page = listGuardrailEvents({ client, headers, query: { ...query, limit: 25, cursor } })
    const [directory, sources] = await Promise.all([
      getWorkspaceDirectory(orgSlug),
      listGuardrailEventSourcesQuery(workspaceId ?? filters.workspace_id),
    ])
    if (sources.error)
      return (
        <AdministrationState
          kind="failed"
          title="Could not load event sources"
          description={sources.error.message}
        />
      )
    const workspaces =
      directory.directory?.workspaces.filter((item) => item.capabilities.guardrail_events.read) ??
      []
    return (
      <div className="flex min-w-0 flex-col">
        <GuardrailEventFilters
          {...query}
          sources={sources.data}
          workspaces={workspaces}
          scopedWorkspaceId={workspaceId}
        />
        <Suspense key={`chart:${JSON.stringify(query)}`} fallback={<EventsChartSkeleton />}>
          <GuardrailChart result={chart} />
        </Suspense>
        <Suspense
          key={`events:${JSON.stringify({ ...query, cursor })}`}
          fallback={<AdministrationLoadingState />}
        >
          <GuardrailEventList result={page} basePath={basePath} workspaceId={workspaceId} />
        </Suspense>
      </div>
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

async function GuardrailChart({
  result,
}: {
  result: ReturnType<typeof getGuardrailEventChart<false>>
}) {
  const response = await result
  if (response.error)
    return (
      <AdministrationState
        kind="failed"
        title="Could not load activity"
        description={response.error.message}
      />
    )
  return (
    <EventsChart
      label="Interventions"
      data={{
        total: response.data.total,
        points: response.data.points.map((point) => ({
          label: dayjs(point.time).format("MMM D, h:mm A"),
          count: point.count,
        })),
      }}
    />
  )
}

async function GuardrailEventList({
  result,
  basePath,
  workspaceId,
}: {
  result: ReturnType<typeof listGuardrailEvents<false>>
  basePath: `/orgs/${string}/guardrails`
  workspaceId?: string
}) {
  const response = await result
  if (response.error)
    return (
      <AdministrationState
        kind="failed"
        title="Could not load guardrail events"
        description={response.error.message}
      />
    )
  return <GuardrailEvents data={response.data} basePath={basePath} workspaceId={workspaceId} />
}
