import assert from "node:assert/strict"
import { test } from "node:test"
import type { AssistantMessage, Event, TextPart } from "@opencode-ai/sdk/v2"
import { applyEvent, buildStore } from "./use-opencode-chat"

const text = "Safe response from the deterministic local demo model."
const assistant: AssistantMessage = {
  id: "message",
  sessionID: "session",
  role: "assistant",
  parentID: "user",
  agent: "build",
  mode: "build",
  providerID: "provider",
  modelID: "model",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 4 },
}
const completed: TextPart = {
  id: "part",
  sessionID: assistant.sessionID,
  messageID: assistant.id,
  type: "text",
  text,
  time: { start: 2, end: 4 },
}

// Captured from native OpenCode 1.18.16: empty part snapshot, one buffered
// text delta, then the completed authoritative snapshot for the same part.
const events: Event[] = [
  {
    id: "event-1",
    type: "message.part.updated",
    properties: {
      sessionID: assistant.sessionID,
      part: { ...completed, text: "", time: { start: 2 } },
      time: 2,
    },
  },
  {
    id: "event-2",
    type: "message.part.delta",
    properties: {
      sessionID: assistant.sessionID,
      messageID: assistant.id,
      partID: completed.id,
      field: "text",
      delta: text,
    },
  },
  {
    id: "event-3",
    type: "message.part.updated",
    properties: { sessionID: assistant.sessionID, part: completed, time: 4 },
  },
]

test("history hydration ahead of queued native events does not duplicate buffered text", () => {
  const hydrated = buildStore(assistant.sessionID, [{ info: assistant, parts: [completed] }])
  const store = events.reduce(applyEvent, hydrated)

  assert.equal(store.part[assistant.id]?.find((part) => part.id === completed.id)?.type, "text")
  assert.deepEqual(store.part[assistant.id], [completed])
})

test("native snapshots and deltas produce the same text without prior history", () => {
  const empty = buildStore(assistant.sessionID, [])
  const store = events.reduce(applyEvent, empty)

  assert.deepEqual(store.part[assistant.id], [completed])
})
