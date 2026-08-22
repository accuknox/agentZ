import { tool } from "@opencode-ai/plugin"

import {
  createAgentDashboard,
  deleteAgentDashboard,
  getAgentDashboard,
  listAgentDashboards,
  replaceAgentDashboard,
  zError,
} from "../lib/gateway"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

const dashboardName = tool.schema
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)

const identifier = tool.schema
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/)

const definition = tool.schema.object({
  name: dashboardName,
  title: tool.schema.string().min(1).max(256),
  description: tool.schema.string().max(2048),
  dimensions: tool.schema
    .array(tool.schema.object({ name: identifier, label: tool.schema.string().min(1).max(128) }))
    .max(32),
  measures: tool.schema
    .array(
      tool.schema.object({
        name: identifier,
        label: tool.schema.string().min(1).max(128),
        unit: tool.schema.string().max(32).optional(),
      })
    )
    .max(32),
  filters: tool.schema.array(
    tool.schema.object({
      id: identifier,
      label: tool.schema.string().min(1).max(128),
      field: identifier,
      multiple: tool.schema.boolean(),
    })
  ),
  widgets: tool.schema.array(
    tool.schema.object({
      id: identifier,
      title: tool.schema.string().min(1).max(256),
      description: tool.schema.string().max(1024).optional(),
      kind: tool.schema.enum(["metric", "line", "area", "bar", "donut", "table"]),
      width: tool.schema.enum(["third", "half", "full"]),
      aggregation: tool.schema.enum(["count", "sum", "avg", "min", "max"]).optional(),
      measure: identifier.optional(),
      group_by: identifier.optional(),
      stacked: tool.schema.boolean().optional(),
      columns: tool.schema.array(tool.schema.string().min(1).max(64)).optional(),
      sort_by: tool.schema.string().min(1).max(64).optional(),
      sort_direction: tool.schema.enum(["asc", "desc"]).optional(),
      limit: tool.schema.number().int().min(1).max(100).optional(),
    })
  ),
})

export default tool({
  description: `
Read or change dashboards owned by the current Agent.

Before create or replace, load the built-in "dashboard-creator" skill. A definition declares fields, filters, and widgets. It cannot contain SQL, JSONPath, JavaScript, CSS, chart-library properties, or colors.

Only an interactive chat session may create, replace, or delete a dashboard. Replace requires the revision returned by get or list. The request fails if another session changed the dashboard after that revision.
`.trim(),
  args: {
    action: tool.schema.enum(["list", "get", "create", "replace", "delete"]),
    dashboard_name: dashboardName.optional(),
    expected_revision: tool.schema.number().int().min(1).optional(),
    definition: definition.optional(),
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

    const result =
      args.action === "list"
        ? await listAgentDashboards({
            path: { agentName },
            headers,
            query: { limit: 100, page_token: args.page_token },
            throwOnError: false,
          })
        : args.action === "get" && args.dashboard_name
          ? await getAgentDashboard({
              path: { agentName, dashboardName: args.dashboard_name },
              headers,
              throwOnError: false,
            })
          : args.action === "create" && args.definition
            ? await createAgentDashboard({
                path: { agentName },
                headers,
                body: args.definition,
                throwOnError: false,
              })
            : args.action === "replace" &&
                args.dashboard_name &&
                args.definition &&
                args.expected_revision
              ? await replaceAgentDashboard({
                  path: { agentName, dashboardName: args.dashboard_name },
                  headers,
                  body: {
                    expected_revision: args.expected_revision,
                    definition: args.definition,
                  },
                  throwOnError: false,
                })
              : args.action === "delete" && args.dashboard_name
                ? await deleteAgentDashboard({
                    path: { agentName, dashboardName: args.dashboard_name },
                    headers,
                    throwOnError: false,
                  })
                : undefined

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
