import { cacheLife, cacheTag } from "next/cache"
import {
  getDashboard,
  listDashboards,
  listDashboardFilterOptions,
  queryDashboardWidget,
  type DashboardQueryRequest,
  type DashboardTimeRange,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

const dashboardsTag = "dashboards"

export async function listDashboardsCachedQuery(workspaceId: string, pageToken?: string) {
  "use cache: private"

  cacheLife({ stale: 30, revalidate: 60, expire: 300 })
  cacheTag(dashboardsTag, `${dashboardsTag}:${workspaceId}`)
  const result = await listDashboards({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    query: { limit: 100, page_token: pageToken },
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export async function getDashboardCachedQuery(workspaceId: string, dashboardId: string) {
  "use cache: private"

  cacheLife({ stale: 30, revalidate: 60, expire: 300 })
  cacheTag(dashboardsTag, `${dashboardsTag}:${workspaceId}`, `${dashboardsTag}:${dashboardId}`)
  const result = await getDashboard({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { dashboardId },
  })
  if (result.response?.status === 404) return null
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export async function queryDashboardWidgetServer(
  workspaceId: string,
  dashboardId: string,
  widgetId: string,
  body: DashboardQueryRequest
) {
  return await queryDashboardWidget({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { dashboardId, widgetId },
    body,
  })
}

export async function listDashboardFilterOptionsServer(
  workspaceId: string,
  dashboardId: string,
  filterId: string,
  body: DashboardTimeRange
) {
  return await listDashboardFilterOptions({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { dashboardId, filterId },
    body,
  })
}
