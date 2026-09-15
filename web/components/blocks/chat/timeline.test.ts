import assert from "node:assert/strict"
import { test } from "node:test"
import type { AssistantMessage, UserMessage, TextPart } from "@opencode-ai/sdk/v2"
import { projectTimeline } from "./timeline"
const user: UserMessage = {
  id: "user1",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
}
const assistant: AssistantMessage = {
  id: "assistant1",
  sessionID: "session",
  role: "assistant",
  time: { created: 2 },
  parentID: user.id,
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const steer: UserMessage = { ...user, id: "user2", time: { created: 3 } }
const parts: Record<string, TextPart[]> = {
  [user.id]: [
    {
      id: "part1",
      sessionID: "session",
      messageID: user.id,
      type: "text",
      text: "Roast this project",
    },
  ],
  [assistant.id]: [
    {
      id: "part2",
      sessionID: "session",
      messageID: assistant.id,
      type: "text",
      text: "My roast is still streaming",
    },
  ],
  [steer.id]: [
    {
      id: "part3",
      sessionID: "session",
      messageID: steer.id,
      type: "text",
      text: "Feel free to use slang",
    },
  ],
}
test("a steering message does not finish the assistant that is still streaming", () => {
  const { rows } = projectTimeline({
    messages: [user, assistant, steer],
    partsByMessage: parts,
    textByPart: {},
    isBusy: true,
    isRetrying: false,
  })
  assert.ok(rows.some((row) => row.type === "assistant"))
  const response = rows.find((row) => row.type === "assistant")
  assert.equal(response?.isStreaming, true)
  assert.equal(
    rows.some((row) => row.type === "thinking"),
    false
  )
  const waiting = rows.find((row) => row.type === "user" && row.messageID === steer.id)
  assert.ok(waiting?.type === "user")
  assert.equal(waiting.isWaiting, true)
})

test("completion moves activity from the previous response to the steering turn", () => {
  const completed = { ...assistant, time: { ...assistant.time, completed: 4 } }
  const { rows } = projectTimeline({
    messages: [user, completed, steer],
    partsByMessage: parts,
    textByPart: {},
    isBusy: true,
    isRetrying: false,
  })
  assert.equal(rows.find((row) => row.type === "assistant")?.isStreaming, false)
  assert.deepEqual(
    rows.filter((row) => row.type === "thinking"),
    [{ key: "thinking:assistant:user2", type: "thinking" }]
  )
})

test("Stop and retry do not leave an unfinished response marked as streaming", () => {
  for (const status of [
    { isBusy: false, isRetrying: false },
    { isBusy: true, isRetrying: true },
  ]) {
    const { rows } = projectTimeline({
      messages: [user, assistant, steer],
      partsByMessage: parts,
      textByPart: {},
      ...status,
    })
    assert.equal(rows.find((row) => row.type === "assistant")?.isStreaming, false)
  }
})

test("a reverted steering message does not move the active response", () => {
  const { rows, reverted } = projectTimeline({
    messages: [user, assistant, steer],
    partsByMessage: parts,
    textByPart: {},
    isBusy: true,
    isRetrying: false,
    revertMessageID: steer.id,
  })
  assert.equal(rows.find((row) => row.type === "assistant")?.isStreaming, true)
  assert.deepEqual(reverted, [{ id: steer.id, text: "Feel free to use slang" }])
})
