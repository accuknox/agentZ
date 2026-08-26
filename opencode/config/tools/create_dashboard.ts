import { tool } from "@opencode-ai/plugin"

import { createDashboard, type CreateDashboardRequest, zError } from "../lib/gateway"
import { zCreateDashboardBody } from "../lib/gateway/client/zod.gen"

const series = tool.schema.object({
  name: tool.schema
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  label: tool.schema.string().min(1).max(80),
  aggregation: tool.schema.enum(["sum", "average", "minimum", "maximum", "last", "count"]),
})

const column = tool.schema.object({
  name: tool.schema
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  label: tool.schema.string().min(1).max(80),
  type: tool.schema.enum(["text", "number", "boolean", "datetime"]),
  sortable: tool.schema.boolean(),
})

export default tool({
  description: `Create an immutable dashboard definition. Load and follow the built-in "dashboard-creator" skill first. If the definition must change later, delete and recreate the dashboard.`,
  args: {
    name: tool.schema
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    title: tool.schema.string().min(1).max(80),
    widgets: tool.schema
      .array(
        tool.schema.object({
          name: tool.schema
            .string()
            .min(1)
            .max(63)
            .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
          title: tool.schema.string().min(1).max(80),
          kind: tool.schema.enum([
            "line",
            "pie",
            "bar",
            "horizontal_grouped_bar",
            "area",
            "step",
            "table",
            "scatter",
            "gauge",
          ]),
          mode: tool.schema.enum(["temporal", "latest"]),
          width: tool.schema.enum(["full", "half", "third"]),
          series: tool.schema.array(series).max(5),
          columns: tool.schema.array(column).max(12),
          minimum: tool.schema.number().optional(),
          maximum: tool.schema.number().optional(),
          thresholds: tool.schema
            .array(
              tool.schema.object({
                value: tool.schema.number(),
                tone: tool.schema.enum(["neutral", "warning", "critical"]),
              })
            )
            .max(5),
        })
      )
      .min(1)
      .max(48),
  },
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) return "AGENTZ_AGENT_NAME is not set."
    const parsed = zCreateDashboardBody.safeParse(args satisfies CreateDashboardRequest)
    if (!parsed.success) {
      return parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
    }
    context.metadata({
      title: `Create dashboard ${args.name}`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.name,
        widget_count: args.widgets.length,
      },
    })
    const result = await createDashboard({
      path: { agentName },
      body: parsed.data,
      throwOnError: false,
    })
    if (result.data) {
      const revisions = result.data.widgets
        .map((widget) => `${widget.name}=${widget.data_revision}`)
        .join(", ")
      return `Created dashboard ${result.data.name}. Data revisions: ${revisions}.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard creation returned an unexpected error."
  },
})
