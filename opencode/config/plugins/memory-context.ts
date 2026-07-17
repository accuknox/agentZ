import type { Plugin } from "@opencode-ai/plugin"

import { memory } from "../lib/memory"

const reviewPrompt = `
Silently review the conversation for context worth carrying into future sessions. Save stable user, project, or environment facts with memory. Append meaningful work outcomes, decisions, evidence, failed approaches, unresolved questions, and next steps to the journal. Keep curated memory and dated history separate. Skip secrets, raw transcripts, routine narration, and reusable procedures. Use at most one call per applicable tool; otherwise do nothing. Never mention this review.
`.trim()

export default (async ({ client }) => {
  if (process.env.AGENTZ_MEMORY_ENABLED !== "true") {
    return {}
  }

  const reviewDue = new Set<string>()

  return {
    async event({ event }) {
      if (event.type === "session.created") {
        await memory.snapshot(event.properties.info.id).catch(() => undefined)
      }
      if (event.type === "session.deleted") {
        reviewDue.delete(event.properties.info.id)
        await memory.removeSnapshot(event.properties.info.id).catch(() => undefined)
      }
    },
    async "chat.message"(input, output) {
      const currentIsReal = output.parts.some(
        (part) => part.type !== "text" || part.synthetic !== true
      )
      if (!currentIsReal) {
        return
      }

      const response = await client.session.messages({
        path: { id: input.sessionID },
        throwOnError: false,
      })
      let currentSaved = false
      let turns = 0
      for (const message of response.data ?? []) {
        currentSaved ||= message.info.id === output.message.id
        if (
          message.info.role === "user" &&
          message.parts.some((part) => part.type !== "text" || part.synthetic !== true)
        ) {
          turns++
        }
      }
      if (!currentSaved) {
        turns++
      }
      if (turns % 10 === 0) {
        reviewDue.add(input.sessionID)
      }
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) {
        return
      }

      const snapshot = await memory.snapshot(input.sessionID).catch(() => undefined)
      if (snapshot) {
        output.system.splice(output.system.length > 0 ? 1 : 0, 0, snapshot)
      }
      if (reviewDue.delete(input.sessionID)) {
        output.system.push(reviewPrompt)
      }
    },
  }
}) satisfies Plugin
