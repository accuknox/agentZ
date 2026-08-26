import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"

import { publishDashboardData, type PublishDashboardDataRequest, zError } from "../lib/gateway"

const name = tool.schema
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  .describe("DNS label using lowercase letters, digits, and hyphens.")

const dateTime = tool.schema.iso.datetime({ offset: true })
const recordedAt = dateTime
  .optional()
  .describe("Required for temporal widgets and forbidden for latest widgets.")

const cell = tool.schema.union([
  tool.schema.object({ text: tool.schema.string().max(1024) }).strict(),
  tool.schema.object({ number: tool.schema.number() }).strict(),
  tool.schema.object({ boolean: tool.schema.boolean() }).strict(),
  tool.schema.object({ datetime: dateTime }).strict(),
])

const record = tool.schema.union([
  tool.schema
    .object({
      recorded_at: recordedAt,
      values: tool.schema.array(tool.schema.number()).min(1).max(5),
    })
    .strict(),
  tool.schema
    .object({
      recorded_at: recordedAt,
      category: tool.schema.string().min(1).max(120),
      values: tool.schema.array(tool.schema.number()).min(1).max(5),
    })
    .strict(),
  tool.schema
    .object({
      recorded_at: recordedAt,
      series: tool.schema.number().int().min(0).max(4),
      x: tool.schema.number(),
      y: tool.schema.number(),
      size: tool.schema.number().min(0).optional(),
      label: tool.schema.string().max(120).optional(),
    })
    .strict(),
  tool.schema
    .object({
      recorded_at: recordedAt,
      cells: tool.schema.array(cell).min(1).max(12),
    })
    .strict(),
])

const input = tool.schema
  .object({
    dashboard_name: name,
    widget_name: name,
    data_revision: tool.schema.string().uuid(),
    records: tool.schema.array(record).min(1).max(100),
  })
  .strict()

export default tool({
  description: `Publish one precomputed widget update. Get the dashboard first and copy the widget's current data_revision. Every temporal record requires recorded_at. Latest records must omit it.`,
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
    const body = {
      data_revision: parsed.data.data_revision,
      records: parsed.data.records,
    } satisfies PublishDashboardDataRequest
    context.metadata({
      title: `Publish ${parsed.data.widget_name}`,
      metadata: {
        dashboard_name: parsed.data.dashboard_name,
        widget_name: parsed.data.widget_name,
        record_count: parsed.data.records.length,
      },
    })
    const result = await publishDashboardData({
      path: {
        agentName,
        dashboardName: parsed.data.dashboard_name,
        widgetName: parsed.data.widget_name,
      },
      headers: {
        "Idempotency-Key": `${context.messageID}:${createHash("sha256")
          .update(
            JSON.stringify({
              dashboard_name: parsed.data.dashboard_name,
              widget_name: parsed.data.widget_name,
              ...body,
            })
          )
          .digest("hex")}`,
      },
      body,
      throwOnError: false,
    })
    if (result.data) {
      return `${result.data.replayed ? "Replayed" : "Accepted"} ${result.data.accepted_records} records for ${parsed.data.widget_name} at ${result.data.received_at}.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard publishing returned an unexpected error."
  },
})
