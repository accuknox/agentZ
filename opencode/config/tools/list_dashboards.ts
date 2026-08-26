import { tool } from "@opencode-ai/plugin"

import { listAgentDashboards, zError } from "../lib/gateway"

export default tool({
  description:
    "List dashboards owned by this agent. Use this before creating a dashboard to avoid name conflicts.",
  args: {},
  async execute(_args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) return "AGENTZ_AGENT_NAME is not set."
    context.metadata({ title: "List dashboards", metadata: { agent_name: agentName } })
    const result = await listAgentDashboards({ path: { agentName }, throwOnError: false })
    if (result.data) {
      if (result.data.dashboards.length === 0) return "No dashboards exist for this agent."
      return result.data.dashboards
        .map(
          (dashboard) =>
            `- ${dashboard.name}: ${dashboard.title} (${dashboard.widget_count} widgets)`
        )
        .join("\n")
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard listing returned an unexpected error."
  },
})
