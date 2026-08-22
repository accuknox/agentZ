import { tool } from "@opencode-ai/plugin"

import {
  createAgentDashboard,
  deleteAgentDashboard,
  getAgentDashboard,
  listAgentDashboards,
  replaceAgentDashboard,
  zError,
} from "../lib/gateway"
import {
  zDashboardDefinition,
  zDashboardName,
  zReplaceDashboardRequest,
} from "../lib/gateway/client/zod.gen"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

export default tool({
  description: `
Read or change dashboards owned by the current Agent.

Before create or replace, load the built-in "dashboard-creator" skill. A definition declares fields, filters, and widgets. It cannot contain SQL, JSONPath, JavaScript, CSS, chart-library properties, or colors.

Only an interactive chat session may create, replace, or delete a dashboard. Replace requires the revision returned by get or list. The request fails if another session changed the dashboard after that revision.
`.trim(),
  args: {
    action: tool.schema.enum(["list", "get", "create", "replace", "delete"]),
    dashboard_name: zDashboardName.optional(),
    expected_revision: zReplaceDashboardRequest.shape.expected_revision.optional(),
    definition: zDashboardDefinition.optional(),
    page_token: tool.schema.string().min(1).optional(),
  },
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before managing dashboards."
    }
    const headers = { "X-AgentZ-Session-ID": context.sessionID }
    context.metadata({
      title: `${args.action} dashboard${args.dashboard_name ? ` ${args.dashboard_name}` : "s"}`,
      metadata: { agent_name: agentName, dashboard_name: args.dashboard_name, action: args.action },
    })

    const result = await (async () => {
      switch (args.action) {
        case "list":
          return listAgentDashboards({
            path: { agentName },
            headers,
            query: { limit: 100, page_token: args.page_token },
            throwOnError: false,
          })
        case "get":
          if (!args.dashboard_name) return
          return getAgentDashboard({
            path: { agentName, dashboardName: args.dashboard_name },
            headers,
            throwOnError: false,
          })
        case "create":
          if (!args.definition) return
          return createAgentDashboard({
            path: { agentName },
            headers,
            body: args.definition,
            throwOnError: false,
          })
        case "replace":
          if (!args.dashboard_name || !args.definition || !args.expected_revision) return
          return replaceAgentDashboard({
            path: { agentName, dashboardName: args.dashboard_name },
            headers,
            body: {
              expected_revision: args.expected_revision,
              definition: args.definition,
            },
            throwOnError: false,
          })
        case "delete":
          if (!args.dashboard_name) return
          return deleteAgentDashboard({
            path: { agentName, dashboardName: args.dashboard_name },
            headers,
            throwOnError: false,
          })
      }
    })()

    if (!result) {
      return "The dashboard request is missing an argument. get and delete need dashboard_name. create needs definition. replace needs dashboard_name, definition, and expected_revision."
    }
    if (result.data) {
      return JSON.stringify(result.data, null, 2)
    }
    if (args.action === "delete" && !result.error) {
      return `Deleted dashboard ${args.dashboard_name}.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? workflowErrorOutput(error.data)
      : "The dashboard service returned an invalid response."
  },
})
