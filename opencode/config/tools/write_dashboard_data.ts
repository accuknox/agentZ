import { tool } from "@opencode-ai/plugin"

import { writeDashboardData, zError } from "../lib/gateway"
import { zDashboardName, zWriteDashboardDataRequest } from "../lib/gateway/client/zod.gen"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

export default tool({
  description: `
Write up to 100 records to a dashboard. The gateway keeps each record for 30 days.

Load the built-in "dashboard-publisher" skill first. Every dimension and measure must exist in the dashboard definition. Use append to keep records separate. Use upsert with a stable record_key when a new write should replace the current record. Do not add fields or change value types.
`.trim(),
  args: {
    dashboard_name: zDashboardName,
    action: zWriteDashboardDataRequest.shape.action,
    records: zWriteDashboardDataRequest.shape.records,
  },
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before publishing dashboard data."
    }
    context.metadata({
      title: `Publish ${args.records.length} records to ${args.dashboard_name}`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.dashboard_name,
        action: args.action,
        record_count: args.records.length,
      },
    })
    const result = await writeDashboardData({
      path: { agentName, dashboardName: args.dashboard_name },
      headers: { "X-AgentZ-Session-ID": context.sessionID },
      body: { action: args.action, records: args.records },
      throwOnError: false,
    })
    if (result.data) {
      return `Published ${result.data.affected} dashboard records using ${args.action}.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? workflowErrorOutput(error.data)
      : "The dashboard service returned an invalid response."
  },
})
