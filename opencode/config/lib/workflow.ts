import type { GatewayError } from "./gateway"

export function agentNameFromResourceAttributes(input: string | undefined) {
  if (!input) {
    return ""
  }

  for (const item of input.split(",")) {
    const [key, value] = item.split("=", 2)
    if (key?.trim() !== "clawarmor.agent_name") {
      continue
    }
    return value?.trim() ?? ""
  }

  return ""
}

export function workflowErrorOutput(error: GatewayError) {
  const lines = [`${error.code}: ${error.message}`]
  for (const field of error.errors ?? []) {
    lines.push(`${field.field}: ${field.message}`)
  }
  return lines.join("\n")
}
