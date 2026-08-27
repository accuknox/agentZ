import { tool } from "@opencode-ai/plugin"

import { deleteDashboard, gatewayErrorOutput, zDashboardName, zError } from "../lib/gateway"

export default tool({
  description:
    "Delete a dashboard definition and all of its data. Use this to replace an immutable definition or repair corrupt stored data.",
  args: {
    dashboard_name: zDashboardName,
  },
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) {
      throw new Error(
        "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before deleting a dashboard."
      )
    }
    await context.ask({
      permission: "dashboard.delete",
      patterns: [args.dashboard_name],
      always: [],
      metadata: { dashboard_name: args.dashboard_name },
    })
    const result = await deleteDashboard({
      path: { agentName, dashboardName: args.dashboard_name },
      throwOnError: false,
    })
    if (!result.error) return `Deleted dashboard ${args.dashboard_name}.`
    const error = zError.safeParse(result.error)
    if (!error.success) {
      throw new Error(
        `Deleting dashboard ${args.dashboard_name} for agent ${agentName} failed because the gateway returned an invalid error response.`
      )
    }
    context.metadata({
      title: `Delete dashboard ${args.dashboard_name} failed`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.dashboard_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    throw new Error(
      `Deleting dashboard ${args.dashboard_name} for agent ${agentName} failed.\n${gatewayErrorOutput(error.data)}`
    )
  },
})
