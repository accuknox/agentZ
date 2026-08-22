import { tool } from "@opencode-ai/plugin"

import { deleteDashboardData, zError } from "../lib/gateway"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

export default tool({
  description:
    "Delete explicitly keyed dashboard records. This destructive tool is restricted to interactive sessions and never deletes unkeyed history.",
  args: {
    dashboard_name: tool.schema
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    record_keys: tool.schema.array(tool.schema.string().min(1).max(256)).min(1).max(100),
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
      return `Deleted ${result.data.affected} keyed dashboard records.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? workflowErrorOutput(error.data)
      : "The dashboard service returned an unexpected error shape."
  },
})
