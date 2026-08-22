import {
  getDashboard,
  listDashboards,
  queryDashboardWidget,
  type DashboardQueryRequest,
  type DashboardSummary,
} from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listAllDashboardsQuery(workspaceId: string) {
  const dashboards: DashboardSummary[] = []
  let pageToken: string | undefined

  do {
    const result = await listDashboards({
      client: getGatewayServerClient(workspaceId),
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      query: { limit: 100, page_token: pageToken },
    })
    if (result.error) throw new Error(result.error.message)
    dashboards.push(...result.data.dashboards)
    pageToken = result.data.next_page_token || undefined
  } while (pageToken)

  return dashboards
}

export async function getDashboardQuery(workspaceId: string, dashboardId: string) {
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
  return queryDashboardWidget({
    client: getGatewayServerClient(workspaceId),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { dashboardId, widgetId },
    body,
  })
}
