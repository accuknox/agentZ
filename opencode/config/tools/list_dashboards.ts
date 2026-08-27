import { tool } from "@opencode-ai/plugin"

import {
  gatewayErrorOutput,
  listAgentDashboards,
  type DashboardSummary,
  zError,
} from "../lib/gateway"

export default tool({
  description:
    "List dashboards owned by this agent. Use this before creating a dashboard to avoid name conflicts.",
  args: {},
  async execute(_args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) {
      throw new Error(
        "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before listing dashboards."
      )
    }
    context.metadata({ title: "List dashboards", metadata: { agent_name: agentName } })
    const dashboards: DashboardSummary[] = []
    let pageToken: string | undefined
    do {
      const result = await listAgentDashboards({
        path: { agentName },
        query: pageToken ? { page_token: pageToken } : undefined,
        throwOnError: false,
      })
      if (!result.data) {
        const error = zError.safeParse(result.error)
        if (!error.success) {
          throw new Error(
            `Listing dashboards for agent ${agentName} failed because the gateway returned an invalid error response.`
          )
        }
        context.metadata({
          title: "List dashboards failed",
          metadata: {
            agent_name: agentName,
            code: error.data.code,
            errors: error.data.errors ?? [],
          },
        })
        throw new Error(
          `Listing dashboards for agent ${agentName} failed.\n${gatewayErrorOutput(error.data)}`
        )
      }
      dashboards.push(...result.data.dashboards)
      pageToken = result.data.next_page_token || undefined
    } while (pageToken)

    if (dashboards.length === 0) return "No dashboards exist for this agent."
    return dashboards
      .map(
        (dashboard) => `- ${dashboard.name}: ${dashboard.title} (${dashboard.widget_count} widgets)`
      )
      .join("\n")
  },
})
