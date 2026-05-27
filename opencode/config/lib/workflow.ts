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
  if ((error.errors ?? []).some((field) => field.field.startsWith("inputs."))) {
    lines.push(
      "Hint: inputs must be a flat object keyed by input name. Each value must be a typed schema object with required `type` and `required` fields. Only scalar input types and the documented schema keys are supported. Bounds must be ordered correctly and `multipleOf` must be greater than 0."
    )
  }
  for (const field of error.errors ?? []) {
    lines.push(`${field.field}: ${field.message}`)
  }
  return lines.join("\n")
}
