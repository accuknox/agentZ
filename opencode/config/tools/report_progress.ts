import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Update the live status at the start and before each work step or group of tools. Refresh it when findings change your next action. Use 3–8 concrete words, e.g. 'Checking deployment logs'. Call alongside the next tool when possible. Avoid stale or generic labels, secrets, private reasoning, raw commands, percentages, and unverified success. Continue working afterward.",
  args: {
    text: tool.schema
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]+$/),
  },
  async execute({ text }, context) {
    context.abort.throwIfAborted()
    context.metadata({ title: text })
    return { title: text, output: "Progress recorded" }
  },
})
