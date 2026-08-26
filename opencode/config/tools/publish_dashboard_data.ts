import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"

import { publishDashboardData, type PublishDashboardDataRequest, zError } from "../lib/gateway"
import { zPublishDashboardDataBody } from "../lib/gateway/client/zod.gen"

const cell = tool.schema.object({
  text: tool.schema.string().max(1024).optional(),
  number: tool.schema.number().optional(),
  boolean: tool.schema.boolean().optional(),
  datetime: tool.schema.string().datetime().optional(),
})

export default tool({
  description: `Publish one precomputed widget update. Get the dashboard first and copy the widget's current data_revision. The gateway rejects data that does not exactly match the immutable definition.`,
  args: {
    dashboard_name: tool.schema
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    widget_name: tool.schema
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
    data_revision: tool.schema.string().uuid(),
    records: tool.schema
      .array(
        tool.schema.object({
          category: tool.schema.string().min(1).max(120).optional(),
          series: tool.schema.number().int().min(0).max(4).optional(),
          values: tool.schema.array(tool.schema.number()).max(5).optional(),
          x: tool.schema.number().optional(),
          y: tool.schema.number().optional(),
          size: tool.schema.number().min(0).optional(),
          label: tool.schema.string().max(120).optional(),
          cells: tool.schema.array(cell).max(12).optional(),
        })
      )
      .min(1)
      .max(100),
  },
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) return "AGENTZ_AGENT_NAME is not set."
    const bodyInput = {
      data_revision: args.data_revision,
      records: args.records,
    } satisfies PublishDashboardDataRequest
    const parsed = zPublishDashboardDataBody.safeParse(bodyInput)
    if (!parsed.success) {
      return parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")
    }
    context.metadata({
      title: `Publish ${args.widget_name}`,
      metadata: {
        dashboard_name: args.dashboard_name,
        widget_name: args.widget_name,
        record_count: args.records.length,
      },
    })
    const result = await publishDashboardData({
      path: { agentName, dashboardName: args.dashboard_name, widgetName: args.widget_name },
      headers: {
        "Idempotency-Key": `${context.messageID}:${createHash("sha256")
          .update(
            JSON.stringify({
              dashboard_name: args.dashboard_name,
              widget_name: args.widget_name,
              ...parsed.data,
            })
          )
          .digest("hex")}`,
      },
      body: parsed.data,
      throwOnError: false,
    })
    if (result.data) {
      return `${result.data.replayed ? "Replayed" : "Accepted"} ${result.data.accepted_records} records for ${args.widget_name} at ${result.data.received_at}.`
    }
    const error = zError.safeParse(result.error)
    return error.success
      ? `${error.data.code}: ${error.data.message}`
      : "Dashboard publishing returned an unexpected error."
  },
})
