import { cacheLife, cacheTag } from "next/cache"
import {
  getDashboard,
  listDashboards,
  queryDashboard,
  type Dashboard,
  type DashboardSummary,
  type Error,
  type QueryDashboardResponse,
} from "@/lib/gateway/client"
import { dashboardTag, dashboardsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listDashboardsCachedQuery(
  workspaceId: string
): Promise<
  { dashboards: DashboardSummary[]; error: undefined } | { dashboards: undefined; error: Error }
> {
  "use cache: private"
  cacheLife("minutes")
  cacheTag(`${dashboardsTag}:${workspaceId}`)
  const { data, error } = await listDashboards({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
  })
  return error
    ? { dashboards: undefined, error }
    : { dashboards: data.dashboards, error: undefined }
}

export async function getDashboardCachedQuery(
  workspaceId: string,
  agentName: string,
  dashboardName: string
): Promise<{ dashboard: Dashboard; error: undefined } | { dashboard: undefined; error: Error }> {
  "use cache: private"
  cacheLife("minutes")
  cacheTag(dashboardTag(agentName, dashboardName))
  const { data, error } = await getDashboard({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { agentName, dashboardName },
  })
  return error ? { dashboard: undefined, error } : { dashboard: data, error: undefined }
}

export async function queryDashboardInitial(
  workspaceId: string,
  agentName: string,
  dashboardName: string,
  from: string,
  to: string
): Promise<QueryDashboardResponse | undefined> {
  const { data } = await queryDashboard({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { agentName, dashboardName },
    body: { from, to, max_points: 240 },
  })
  return data
}
