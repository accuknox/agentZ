import assert from "node:assert/strict"
import { test } from "node:test"
import type { DelegationModel } from "@/lib/gateway/client"
import { externalAgentKinds, externalAgentSupportsModel } from "./external-agent-kinds"

function model(
  api: "Responses" | "Messages" | "ChatCompletions",
  support: "native" | "translated" | "unsupported",
  tools = true,
  name = "claude-sonnet-4-6"
) {
  return {
    model: name,
    model_info: { capabilities: { tool_call: tools } },
    api_compatibility: [{ api, support }],
  } as DelegationModel
}

for (const kind of externalAgentKinds) {
  test(`${kind}: missing compatibility metadata fails closed`, () => {
    assert.equal(externalAgentSupportsModel(kind, { model: "unknown" } as DelegationModel), false)
  })
}
for (const kind of ["codex", "chatgpt-desktop"] as const) {
  test(`${kind}: requires native Responses and tools`, () => {
    assert.equal(externalAgentSupportsModel(kind, model("Responses", "native")), true)
    assert.equal(externalAgentSupportsModel(kind, model("Responses", "translated")), false)
    assert.equal(externalAgentSupportsModel(kind, model("Responses", "native", false)), false)
    assert.equal(externalAgentSupportsModel(kind, model("Messages", "native")), false)
  })
}
for (const kind of ["github-copilot-cli", "github-copilot-desktop"] as const) {
  test(`${kind}: custom tools need a native Responses or Messages route`, () => {
    assert.equal(externalAgentSupportsModel(kind, model("Responses", "native")), true)
    assert.equal(externalAgentSupportsModel(kind, model("Messages", "native")), true)
    assert.equal(externalAgentSupportsModel(kind, model("ChatCompletions", "native")), false)
    assert.equal(externalAgentSupportsModel(kind, model("Responses", "translated")), false)
    assert.equal(externalAgentSupportsModel(kind, model("Messages", "native", false)), false)
  })
}
test("Claude desktop requires a recognized Claude model and tools", () => {
  assert.equal(externalAgentSupportsModel("claude-desktop", model("Messages", "native")), true)
  assert.equal(
    externalAgentSupportsModel("claude-desktop", model("Messages", "native", true, "gpt-5")),
    false
  )
  assert.equal(
    externalAgentSupportsModel("claude-desktop", model("Messages", "native", false)),
    false
  )
})
test("Claude Code retains translated Messages support", () => {
  assert.equal(externalAgentSupportsModel("claude", model("Messages", "translated")), true)
  assert.equal(externalAgentSupportsModel("claude", model("Messages", "unsupported")), false)
})
