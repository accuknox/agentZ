import type { Plugin } from "@opencode-ai/plugin"

const workflowContext = `
Use list_workflows to discover saved workflows and get_workflow to read their definitions.

- Call the workflow-creator skill before creating or revising workflow definitions.
- Call the workflow-scheduler skill before creating, changing, or deleting workflow schedules.
- Call the workflow-results skill before reviewing workflow results or recovering failed runs.

Continue only authorized work. Honor canceled work and paused or deleted schedules.
`.trim()

export default (async ({ client, directory }) => {
  if (process.env.AGENTZ_WORKSPACE_TYPE === "coding") return {}

  return {
    async "experimental.chat.messages.transform"(_input, output) {
      const latest = [...output.messages].reverse().find((message) => message.info.role === "user")
      if (!latest || latest.info.role !== "user" || latest.info.system) return
      if (
        !latest.parts.some(
          (part) =>
            part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true
        )
      )
        return

      // OpenCode's automatic continuation drops request system instructions.
      // Recover them from native history only across completed automatic compactions.
      const { data: history } = await client.session.messages({
        path: { id: latest.info.sessionID },
        query: { directory },
        throwOnError: true,
      })
      let system: string | undefined
      let compactionID: string | undefined
      let compacted = false
      for (const message of history) {
        if (message.info.role === "assistant") {
          if (message.info.summary && message.info.parentID === compactionID)
            compacted = !!message.info.time.completed && !message.info.error
          continue
        }
        if (message.parts.some((part) => part.type === "compaction" && part.auto)) {
          compactionID = message.info.id
          compacted = false
          continue
        }
        const continuation = message.parts.some(
          (part) =>
            part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true
        )
        if (!compacted || !continuation) system = message.info.system
        compactionID = undefined
        compacted = false
        if (message.info.id === latest.info.id) {
          if (system) {
            for (const part of latest.parts) {
              if (part.type === "text" && part.metadata?.compaction_continue === true)
                part.text = `${system}\n\n${part.text}`
            }
          }
          break
        }
      }
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(workflowContext)
    },
  }
}) satisfies Plugin
