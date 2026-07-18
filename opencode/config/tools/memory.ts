import { tool } from "@opencode-ai/plugin"

import { memory } from "../lib/memory"

const target = tool.schema
  .enum(["profile", "memory"])
  .describe('Use "profile" for user facts and "memory" for project or environment facts.')
const action = tool.schema.enum(["list", "add", "replace", "remove"])
const text = tool.schema
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "value cannot be blank")
const content = text.describe("Fact to add or replacement fact.")
const oldText = text.describe("Unique substring of the entry to replace or remove.")

const request = tool.schema.discriminatedUnion("action", [
  tool.schema.object({ target, action: tool.schema.literal("list") }),
  tool.schema.object({ target, action: tool.schema.literal("add"), content }),
  tool.schema.object({
    target,
    action: tool.schema.literal("replace"),
    content,
    old_text: oldText,
  }),
  tool.schema.object({ target, action: tool.schema.literal("remove"), old_text: oldText }),
])

const description = `
Save compact, high-signal facts that persist across sessions. The best memory prevents the user from having to repeat or correct themselves.

WHEN: save preferences, corrections, expectations, personal details, and stable environment or project facts. Prioritize user preferences and recurring corrections over procedural details.

TARGETS: "profile" is who the user is - preferences, role, style, and workflow. "memory" is durable project or environment facts, conventions, tool quirks, and lessons.

WRITE declarative facts, not instructions. Keep each entry compact and information-dense.

SKIP secrets, easily rediscovered facts, raw dumps, task progress, completed-work logs, temporary TODOs, short-lived identifiers, and project instructions. Reusable procedures belong in skills.

HOW: exact duplicate adds are no-ops. Replace and remove require a substring matching one entry. If full, list the store, remove or consolidate entries, and retry.

Memory is frozen when a session starts. Writes are durable immediately and appear in new sessions only.
`.trim()

export default tool({
  description,
  args: {
    target,
    action,
    content: content.optional(),
    old_text: oldText.optional(),
  },
  async execute(args, context) {
    const parsed = request.safeParse(args)
    if (!parsed.success) {
      throw new Error(`invalid memory request: ${tool.schema.prettifyError(parsed.error)}`)
    }
    const input = parsed.data
    context.metadata({
      title: `${input.action} ${input.target}`,
      metadata: { action: input.action, target: input.target },
    })

    switch (input.action) {
      case "list":
        return JSON.stringify(await memory.list(input.target))
      case "add": {
        const result = await memory.change(input.target, [input])
        return JSON.stringify({ changed: result.changed, used: result.used, limit: result.limit })
      }
      case "replace": {
        const result = await memory.change(input.target, [input])
        return JSON.stringify({ changed: result.changed, used: result.used, limit: result.limit })
      }
      case "remove": {
        const result = await memory.change(input.target, [input])
        return JSON.stringify({ changed: result.changed, used: result.used, limit: result.limit })
      }
    }
  },
})
