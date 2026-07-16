import { tool } from "@opencode-ai/plugin"

import { memory, type MemoryChange } from "../lib/memory"

const batchChange = tool.schema.discriminatedUnion("action", [
  tool.schema.object({
    action: tool.schema.literal("add"),
    content: tool.schema.string().min(1).describe("Compact declarative fact to save."),
  }),
  tool.schema.object({
    action: tool.schema.literal("replace"),
    old_text: tool.schema.string().min(1).describe("Unique substring of the entry to replace."),
    content: tool.schema.string().min(1).describe("Compact replacement fact."),
  }),
  tool.schema.object({
    action: tool.schema.literal("remove"),
    old_text: tool.schema.string().min(1).describe("Unique substring of the entry to remove."),
  }),
])

const description = `
Save compact, high-signal facts that persist across sessions and appear in every future session. The best memory prevents the user from having to repeat or correct themselves.

WHEN: save proactively when the user states a preference, correction, expectation, or personal detail, or when you learn a stable fact about their environment, tools, or conventions. Prioritize user preferences and recurring corrections over procedural details.

TARGETS: "profile" is who the user is - their preferences, role, style, and workflow. "memory" is durable project or environment facts, conventions, tool quirks, and lessons.

WRITE declarative facts, not instructions: "User prefers concise responses" is memory; "Always respond concisely" is not. Keep each entry compact and information-dense.

SKIP secrets, obvious or easily rediscovered facts, raw dumps, task progress, completed-work logs, temporary TODOs, identifiers such as PR numbers or commit SHAs, and anything likely stale within a week. Do not duplicate project instructions. Reusable procedures belong in skills, not memory.

HOW: use one batch call for multiple changes or consolidation. Batch is atomic and checks the character limit only against the final result, so it can remove or shorten stale entries and add a replacement in one call. Use list when you need the current inventory. Exact duplicate adds are successful no-ops. Replace and remove require an old_text substring matching exactly one entry. If capacity is exceeded, list the store and retry once with a consolidating batch.

Memory is frozen when a session starts. Writes are durable immediately but become context only in new sessions. A successful response completes the update; do not repeat it.
`.trim()

export default tool({
  description,
  args: {
    target: tool.schema
      .enum(["memory", "profile"])
      .describe('Use "profile" for user facts and "memory" for project or environment facts.'),
    action: tool.schema
      .enum(["list", "add", "replace", "remove", "batch"])
      .describe("Operation to perform. Prefer batch for multiple related changes."),
    content: tool.schema
      .string()
      .min(1)
      .describe("Compact declarative fact required by add and replace.")
      .optional(),
    old_text: tool.schema
      .string()
      .min(1)
      .describe("Unique substring required by replace and remove.")
      .optional(),
    operations: tool.schema
      .array(batchChange)
      .min(1)
      .describe("Atomic ordered changes required by batch; capacity is checked on the final state.")
      .optional(),
  },
  async execute(args, context) {
    if (process.env.AGENTZ_MEMORY_ENABLED !== "true") {
      throw new Error("Persistent memory is disabled for this agent")
    }

    context.metadata({
      title: `${args.action} ${args.target}`,
      metadata: {
        action: args.action,
        target: args.target,
      },
    })

    if (args.action === "list") {
      return JSON.stringify(await memory.list(args.target))
    }

    let changes: MemoryChange[]
    switch (args.action) {
      case "add":
        if (args.content === undefined) {
          throw new Error("content is required for add")
        }
        changes = [{ action: "add", content: args.content }]
        break
      case "replace":
        if (args.old_text === undefined || args.content === undefined) {
          throw new Error("old_text and content are required for replace")
        }
        changes = [{ action: "replace", old_text: args.old_text, content: args.content }]
        break
      case "remove":
        if (args.old_text === undefined) {
          throw new Error("old_text is required for remove")
        }
        changes = [{ action: "remove", old_text: args.old_text }]
        break
      case "batch":
        if (args.operations === undefined) {
          throw new Error("operations are required for batch")
        }
        changes = args.operations
        break
    }

    const result = await memory.change(args.target, changes)
    return JSON.stringify({
      changed: result.changed,
      used: result.used,
      limit: result.limit,
    })
  },
})
