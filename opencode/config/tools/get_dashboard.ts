import { tool } from "@opencode-ai/plugin"

import { getDashboard, zError } from "../lib/gateway"

export default tool({
  description:
    "Get a dashboard definition and each widget data_revision. Always call this before publishing data.",
  args: {
    dashboard_name: tool.schema
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  },
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) return "AGENTZ_AGENT_NAME is not set."
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
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard retrieval returned an unexpected error."
  },
})
