import { tool } from "@opencode-ai/plugin"

import { createDashboard, type CreateDashboardRequest, zError } from "../lib/gateway"

const name = tool.schema
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  .describe("DNS label using lowercase letters, digits, and hyphens.")

const series = tool.schema
  .object({
    name,
    label: tool.schema.string().min(1).max(80),
    aggregation: tool.schema.enum(["sum", "average", "minimum", "maximum", "last", "count"]),
  })
  .strict()

const axis = tool.schema
  .object({
    label: tool.schema.string().min(1).max(80),
    unit: tool.schema.string().min(1).max(32).optional(),
  })
  .strict()

const column = tool.schema
  .object({
    name,
    label: tool.schema.string().min(1).max(80),
    type: tool.schema.enum(["text", "number", "boolean", "datetime"]),
    sortable: tool.schema.boolean(),
  })
  .strict()

const threshold = tool.schema
  .object({
    value: tool.schema.number(),
    tone: tool.schema.enum(["neutral", "warning", "critical"]),
  })
  .strict()

const common = {
  name,
  title: tool.schema.string().min(1).max(80),
  width: tool.schema.enum(["full", "half", "third"]),
}

const emptySeries = tool.schema.array(series).max(0)
const chartSeries = tool.schema.array(series).min(1).max(5)
const emptyColumns = tool.schema.array(column).max(0)
const noThresholds = tool.schema.array(threshold).max(0)

const widget = tool.schema.discriminatedUnion("kind", [
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("line"),
      mode: tool.schema.literal("temporal"),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("area"),
      mode: tool.schema.literal("temporal"),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("step"),
      mode: tool.schema.literal("temporal"),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("pie"),
      mode: tool.schema.literal("latest"),
      series: tool.schema.array(series).length(1),
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("bar"),
      mode: tool.schema.enum(["temporal", "latest"]),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("horizontal_grouped_bar"),
      mode: tool.schema.enum(["temporal", "latest"]),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("scatter"),
      mode: tool.schema.enum(["temporal", "latest"]),
      axes: tool.schema.object({ x: axis, y: axis }).strict(),
      series: chartSeries,
      columns: emptyColumns,
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("table"),
      mode: tool.schema.enum(["temporal", "latest"]),
      series: emptySeries,
      columns: tool.schema.array(column).min(1).max(12),
      thresholds: noThresholds,
    })
    .strict(),
  tool.schema
    .object({
      ...common,
      kind: tool.schema.literal("gauge"),
      mode: tool.schema.literal("latest"),
      series: tool.schema.array(series).length(1),
      columns: emptyColumns,
      minimum: tool.schema.number(),
      maximum: tool.schema.number(),
      thresholds: tool.schema.array(threshold).max(5),
    })
    .strict()
    .refine((value) => value.minimum < value.maximum, {
      message: "minimum must be less than maximum",
      path: ["maximum"],
    }),
])

const input = tool.schema
  .object({
    name,
    title: tool.schema.string().min(1).max(80),
    widgets: tool.schema.array(widget).min(1).max(48),
  })
  .strict()

export default tool({
  description: `Create an immutable dashboard definition. Load and follow the built-in "dashboard-creator" skill first. If the definition must change later, delete and recreate the dashboard.`,
  args: input.shape,
  async execute(args, context) {
    const parsed = input.safeParse(args)
    if (!parsed.success) {
      return parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
    }
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) return "AGENTZ_AGENT_NAME is not set."
    const body = parsed.data satisfies CreateDashboardRequest
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
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard creation returned an unexpected error."
  },
})
