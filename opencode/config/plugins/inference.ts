import type { Plugin } from "@opencode-ai/plugin"

const openAICodexProviderIDs = new Set(
  process.env.AGENTZ_OPENAI_CODEX_PROVIDER_IDS?.split(",") ?? []
)
const openAICodexPoolIDs = new Set(process.env.AGENTZ_OPENAI_CODEX_POOL_IDS?.split(",") ?? [])
const gitHubCopilotProviderIDs = new Set(
  process.env.AGENTZ_GITHUB_COPILOT_PROVIDER_IDS?.split(",") ?? []
)
const gitHubCopilotPoolIDs = new Set(process.env.AGENTZ_GITHUB_COPILOT_POOL_IDS?.split(",") ?? [])

export default (async (plugin) => ({
  async "chat.params"(input, output) {
    if (
      openAICodexProviderIDs.has(input.model.providerID) ||
      openAICodexPoolIDs.has(input.model.id)
    ) {
      output.maxOutputTokens = undefined
      return
    }

    if (
      !gitHubCopilotProviderIDs.has(input.model.providerID) &&
      !gitHubCopilotPoolIDs.has(input.model.id)
    ) {
      return
    }
    if (input.model.api.id.includes("gpt")) {
      output.maxOutputTokens = undefined
    }
    if (input.model.api.npm === "@ai-sdk/anthropic") {
      output.options.toolStreaming = false
    }
  },
  async "chat.headers"(input, output) {
    if (
      !gitHubCopilotProviderIDs.has(input.model.providerID) &&
      !gitHubCopilotPoolIDs.has(input.model.id)
    ) {
      return
    }

    output.headers["x-initiator"] = "user"
    if (input.agent === "title") {
      output.headers["x-interaction-type"] = "agent-session-name-generation"
    }
    if (input.model.api.npm === "@ai-sdk/anthropic") {
      output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
    }

    const message = await plugin.client.session
      .message({
        path: {
          id: input.message.sessionID,
          messageID: input.message.id,
        },
        query: { directory: plugin.directory },
        throwOnError: true,
      })
      .catch(() => undefined)
    if (
      message?.data.parts?.some(
        (part) =>
          part.type === "compaction" ||
          (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true)
      )
    ) {
      output.headers["x-initiator"] = "agent"
      return
    }

    const session = await plugin.client.session
      .get({
        path: { id: input.sessionID },
        query: { directory: plugin.directory },
        throwOnError: true,
      })
      .catch(() => undefined)
    if (session?.data.parentID) {
      output.headers["x-initiator"] = "agent"
    }
  },
})) satisfies Plugin
