import { tool } from "@opencode-ai/plugin"

import { memory } from "../lib/memory"

const change = tool.schema.discriminatedUnion("action", [
  tool.schema.object({
    action: tool.schema.literal("add"),
    content: tool.schema
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "content cannot be blank")
      .describe("Compact declarative fact to save."),
  }),
  tool.schema.object({
    action: tool.schema.literal("replace"),
    old_text: tool.schema
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "old_text cannot be blank")
      .describe("Unique substring of the entry."),
    content: tool.schema
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "content cannot be blank")
      .describe("Compact replacement fact."),
  }),
  tool.schema.object({
    action: tool.schema.literal("remove"),
    old_text: tool.schema
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, "old_text cannot be blank")
      .describe("Unique substring of the entry."),
  }),
])

const operation = tool.schema.discriminatedUnion("action", [
  tool.schema.object({ action: tool.schema.literal("list") }),
  ...change.options,
  tool.schema.object({
    action: tool.schema.literal("batch"),
    changes: tool.schema
      .array(change)
      .min(1)
      .describe("Atomic ordered changes; capacity is checked against the final state."),
  }),
])

const description = `
Save compact, high-signal facts that persist across sessions. The best memory prevents the user from having to repeat or correct themselves.

WHEN: save preferences, corrections, expectations, personal details, and stable environment or project facts. Prioritize user preferences and recurring corrections over procedural details.

TARGETS: "profile" is who the user is - preferences, role, style, and workflow. "memory" is durable project or environment facts, conventions, tool quirks, and lessons.

WRITE declarative facts, not instructions. Keep each entry compact and information-dense.

SKIP secrets, easily rediscovered facts, raw dumps, task progress, completed-work logs, temporary TODOs, short-lived identifiers, and project instructions. Reusable procedures belong in skills.

HOW: batch related changes so consolidation and replacement are atomic. Exact duplicate adds are no-ops. Replace and remove require a substring matching one entry. If full, list the store and retry once with a consolidating batch.

Memory is frozen when a session starts. Writes are durable immediately and appear in new sessions only.
`.trim()

export default tool({
  description,
  args: {
    target: tool.schema
      .enum(["profile", "memory"])
      .describe('Use "profile" for user facts and "memory" for project or environment facts.'),
    operation,
  },
  async execute(args, context) {
    const { operation, target } = args
    context.metadata({
      title: `${operation.action} ${target}`,
      metadata: { action: operation.action, target },
    })

    switch (operation.action) {
      case "list":
        return JSON.stringify(await memory.list(target))
      case "add":
      case "replace":
      case "remove": {
        const result = await memory.change(target, [operation])
        return JSON.stringify({ changed: result.changed, used: result.used, limit: result.limit })
      }
      case "batch": {
        const result = await memory.change(target, operation.changes)
        return JSON.stringify({ changed: result.changed, used: result.used, limit: result.limit })
      }
    }
  },
})
