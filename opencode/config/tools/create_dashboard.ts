import { tool } from "@opencode-ai/plugin"

import {
  createDashboard,
  gatewayErrorOutput,
  zCreateDashboardRequest,
  zError,
} from "../lib/gateway"

const input = zCreateDashboardRequest

export default tool({
  description: `Create an immutable dashboard definition. Load and follow the built-in "dashboard-creator" skill first. If the definition must change later, delete and recreate the dashboard.`,
  args: input.shape,
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before creating a dashboard."
    }
    const body = args
    context.metadata({
      title: `Create dashboard ${body.name}`,
      metadata: {
        agent_name: agentName,
        dashboard_name: body.name,
        widget_count: body.widgets.length,
      },
    })
    const result = await createDashboard({
      path: { agentName },
      body,
      throwOnError: false,
    })
    if (result.data) {
      const revisions = result.data.widgets
        .map((widget) => `${widget.name}=${widget.data_revision}`)
        .join(", ")
      return `Created dashboard ${result.data.name}. Data revisions: ${revisions}.`
    }
    const error = zError.safeParse(result.error)
    if (!error.success) {
      return `Creating dashboard ${body.name} for agent ${agentName} failed because the gateway returned an invalid error response.`
    }
    context.metadata({
      title: `Create dashboard ${body.name} failed`,
      metadata: {
        agent_name: agentName,
        dashboard_name: body.name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return `Creating dashboard ${body.name} for agent ${agentName} failed.\n${gatewayErrorOutput(error.data)}`
  },
})
