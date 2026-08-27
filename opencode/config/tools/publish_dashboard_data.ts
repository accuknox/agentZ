import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { open, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { TextDecoder } from "node:util"

import {
  gatewayErrorOutput,
  publishDashboardData,
  zDashboardName,
  zDashboardWidgetName,
  zError,
  zPublishDashboardDataRequest,
} from "../lib/gateway"

const maxFileBytes = 8 * 1024 * 1024
const agentHome = process.env.AGENTZ_HOME ?? "/home/agentz"

const records = zPublishDashboardDataRequest.shape.records.describe(
  "Publish 1-100 small records inline when they are already in context."
)

const recordInput = tool.schema.union([
  records,
  tool.schema
    .object({
      json_file: tool.schema
        .string()
        .min(1)
        .describe(
          "Path under the agent home directory to a UTF-8 JSON array of 1-100 records, up to 8 MiB. Relative paths resolve from the session directory. The gateway request-byte limit still applies."
        ),
    })
    .strict()
    .describe(
      "Use a JSON file when records already exist on disk or would waste model context. Do not read the file merely to copy its records into this call."
    ),
])

const input = tool.schema
  .object({
    dashboard_name: zDashboardName,
    widget_name: zDashboardWidgetName,
    data_revision: zPublishDashboardDataRequest.shape.data_revision,
    records: recordInput,
  })
  .strict()

export default tool({
  description: `Publish one precomputed widget update. Get the dashboard first and copy the widget's current data_revision. Pass small datasets inline. For records already on disk or large enough to waste model context, pass records as {"json_file":"path"} without reading the file first. Each call still accepts 1-100 records and the configured request-byte limit. Every temporal record requires recorded_at. Latest records must omit it.`,
  args: input.shape,
  async execute(args, context) {
    const agentName = process.env.AGENTZ_AGENT_NAME?.trim() ?? ""
    if (!agentName) {
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before publishing dashboard data."
    }

    let recordsToPublish = args.records
    if (!Array.isArray(recordsToPublish)) {
      let paths: [string, string, string, string]
      try {
        paths = await Promise.all([
          realpath(agentHome),
          realpath(resolve(context.directory, recordsToPublish.json_file)),
          realpath(context.directory),
          realpath(context.worktree),
        ])
      } catch {
        context.abort.throwIfAborted()
        return "records.json_file: file does not exist or is not accessible."
      }

      const [homePath, path, directoryPath, worktreePath] = paths
      const withinHome = relative(homePath, path)
      if (withinHome === "" || withinHome === ".." || withinHome.startsWith(`..${sep}`)) {
        return "records.json_file: file must be below the agent home directory."
      }

      const fromDirectory = relative(directoryPath, path)
      const fromWorktree = relative(worktreePath, path)
      const outsideDirectory = fromDirectory === ".." || fromDirectory.startsWith(`..${sep}`)
      const outsideWorktree =
        worktreePath === "/" || fromWorktree === ".." || fromWorktree.startsWith(`..${sep}`)
      if (outsideDirectory && outsideWorktree) {
        const parentDir = dirname(path)
        const pattern = join(parentDir, "*").replaceAll("\\", "/")
        await context.ask({
          permission: "external_directory",
          patterns: [pattern],
          always: [pattern],
          metadata: { filepath: path, parentDir },
        })
      }

      await context.ask({
        permission: "read",
        patterns: [relative(context.worktree, path)],
        always: ["*"],
        metadata: {},
      })

      let bytes: Buffer
      try {
        const file = await open(path, "r")
        try {
          const info = await file.stat()
          if (!info.isFile()) return "records.json_file: path is not a regular file."
          if (info.size > maxFileBytes) return "records.json_file: file exceeds 8 MiB."
          bytes = await file.readFile({ signal: context.abort })
        } finally {
          await file.close()
        }
      } catch {
        context.abort.throwIfAborted()
        return "records.json_file: file could not be read."
      }
      if (bytes.byteLength > maxFileBytes) return "records.json_file: file exceeds 8 MiB."

      let contents: string
      try {
        contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        return "records.json_file: file is not valid UTF-8."
      }

      let value: unknown
      try {
        value = JSON.parse(contents)
      } catch {
        return "records.json_file: file is not valid JSON."
      }

      const result = records.safeParse(value)
      if (!result.success) {
        return result.error.issues
          .map((issue) => `${["records", ...issue.path].join(".")}: ${issue.message}`)
          .join("\n")
      }
      recordsToPublish = result.data
    }

    const body = {
      data_revision: args.data_revision,
      records: recordsToPublish,
    }
    context.metadata({
      title: `Publish ${args.widget_name}`,
      metadata: {
        dashboard_name: args.dashboard_name,
        widget_name: args.widget_name,
        record_count: recordsToPublish.length,
      },
    })
    const result = await publishDashboardData({
      path: {
        agentName,
        dashboardName: args.dashboard_name,
        widgetName: args.widget_name,
      },
      headers: {
        "Idempotency-Key": `${context.messageID}:${createHash("sha256")
          .update(
            JSON.stringify({
              dashboard_name: args.dashboard_name,
              widget_name: args.widget_name,
              ...body,
            })
          )
          .digest("hex")}`,
      },
      body,
      signal: context.abort,
      throwOnError: false,
    })
    if (result.data) {
      return `${result.data.replayed ? "Replayed" : "Accepted"} ${result.data.accepted_records} records for ${args.widget_name} at ${result.data.received_at}.`
    }
    const error = zError.safeParse(result.error)
    if (!error.success) {
      return `Publishing ${recordsToPublish.length} records to ${args.dashboard_name}/${args.widget_name} failed because the gateway returned an invalid error response.`
    }
    context.metadata({
      title: `Publish ${args.widget_name} failed`,
      metadata: {
        agent_name: agentName,
        dashboard_name: args.dashboard_name,
        widget_name: args.widget_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return `Publishing to ${args.dashboard_name}/${args.widget_name} failed.\n${gatewayErrorOutput(error.data)}`
  },
})
