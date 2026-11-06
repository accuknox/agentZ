import type { DelegationModel } from "@/lib/gateway/client"

/** Persisted identifiers: never rename existing Claude Code/Codex registrations. */
export const externalAgentKinds = [
  "claude",
  "codex",
  "chatgpt-desktop",
  "claude-desktop",
  "github-copilot-cli",
  "github-copilot-desktop",
] as const
export type ExternalAgentKind = (typeof externalAgentKinds)[number]

export const externalAgentLabels: Record<ExternalAgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  "chatgpt-desktop": "ChatGPT desktop",
  "claude-desktop": "Claude desktop",
  "github-copilot-cli": "GitHub Copilot CLI",
  "github-copilot-desktop": "GitHub Copilot desktop",
}

export function externalAgentAPI(kind: ExternalAgentKind, model?: DelegationModel) {
  if (kind === "claude" || kind === "claude-desktop") return "Messages" as const
  if (kind === "codex" || kind === "chatgpt-desktop") return "Responses" as const
  return model?.api_compatibility?.some(
    (item) => item.api === "Responses" && item.support === "native"
  )
    ? ("Responses" as const)
    : ("Messages" as const)
}

/** Shared by consent rendering and server validation; absent metadata fails closed. */
export function externalAgentSupportsModel(kind: ExternalAgentKind, model: DelegationModel) {
  if (kind.startsWith("github-copilot-"))
    return (
      !!model.model_info?.capabilities.tool_call &&
      !!model.api_compatibility?.some(
        (item) => (item.api === "Responses" || item.api === "Messages") && item.support === "native"
      )
    )
  const api = externalAgentAPI(kind)
  const compatibility = model.api_compatibility?.find((item) => item.api === api)
  if (!compatibility || compatibility.support === "unsupported") return false
  if (kind === "codex" || kind === "chatgpt-desktop")
    return compatibility.support === "native" && !!model.model_info?.capabilities.tool_call
  if (kind === "claude-desktop")
    return model.model.startsWith("claude-") && !!model.model_info?.capabilities.tool_call
  return true
}
