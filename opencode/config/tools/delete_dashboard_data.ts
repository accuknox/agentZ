import { tool } from "@opencode-ai/plugin"

import { deleteDashboardData, zError } from "../lib/gateway"
import { zDashboardName, zDeleteDashboardDataRequest } from "../lib/gateway/client/zod.gen"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

export default tool({
  description:
    "Delete dashboard records by record key. Only interactive chat sessions may run this tool. It cannot delete records without keys.",
  args: {
    dashboard_name: zDashboardName,
    record_keys: zDeleteDashboardDataRequest.shape.record_keys,
  },
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before deleting dashboard data."
    }
    context.metadata({
      title: `Delete dashboard records from ${args.dashboard_name}`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.dashboard_name,
        record_count: args.record_keys.length,
      },
    })
    const result = await deleteDashboardData({
      path: { agentName, dashboardName: args.dashboard_name },
      headers: { "X-AgentZ-Session-ID": context.sessionID },
      body: { record_keys: args.record_keys },
      throwOnError: false,
    })
    if (result.data) {
      return `Deleted ${result.data.affected} dashboard records.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? workflowErrorOutput(error.data)
      : "The dashboard service returned an invalid response."
  },
})
