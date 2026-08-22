import { tool } from "@opencode-ai/plugin"

import { writeDashboardData, zError } from "../lib/gateway"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

export default tool({
  description: `
Write up to 100 records to a dashboard. The gateway keeps each record for 30 days.

Load the built-in "dashboard-publisher" skill first. Every dimension and measure must exist in the dashboard definition. Use append to keep records separate. Use upsert with a stable record_key when a new write should replace the current record. Do not add fields or change value types.
`.trim(),
  args: {
    dashboard_name: tool.schema
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    action: tool.schema.enum(["append", "upsert"]),
    records: tool.schema
      .array(
        tool.schema.object({
          record_key: tool.schema.string().min(1).max(256).optional(),
          observed_at: tool.schema
            .string()
            .describe("Time the source event occurred, formatted as RFC 3339."),
          dimensions: tool.schema.record(tool.schema.string(), tool.schema.string().max(1024)),
          measures: tool.schema.record(tool.schema.string(), tool.schema.number()),
        })
      )
      .min(1)
      .max(100),
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
