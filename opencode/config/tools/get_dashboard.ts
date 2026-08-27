import { tool } from "@opencode-ai/plugin"

import { gatewayErrorOutput, getDashboard, zDashboardName, zError } from "../lib/gateway"

export default tool({
  description:
    "Get a dashboard definition and each widget data_revision. Always call this before publishing data.",
  args: {
    dashboard_name: zDashboardName,
  },
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before getting a dashboard."
    }
    context.metadata({
      title: `Get dashboard ${args.dashboard_name}`,
      metadata: { agent_name: agentName, dashboard_name: args.dashboard_name },
    })
    const result = await getDashboard({
      path: { agentName, dashboardName: args.dashboard_name },
      throwOnError: false,
    })
    if (result.data) return JSON.stringify(result.data, null, 2)
    const error = zError.safeParse(result.error)
    if (!error.success) {
      return `Getting dashboard ${args.dashboard_name} for agent ${agentName} failed because the gateway returned an invalid error response.`
    }
    context.metadata({
      title: `Get dashboard ${args.dashboard_name} failed`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.dashboard_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return `Getting dashboard ${args.dashboard_name} for agent ${agentName} failed.\n${gatewayErrorOutput(error.data)}`
  },
})
