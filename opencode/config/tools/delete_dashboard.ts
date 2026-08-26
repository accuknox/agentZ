import { tool } from "@opencode-ai/plugin"

import { deleteDashboard, zError } from "../lib/gateway"

export default tool({
  description:
    "Delete a dashboard definition and all of its data. Use this to replace an immutable definition or repair corrupt stored data.",
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
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard deletion returned an unexpected error."
  },
})
