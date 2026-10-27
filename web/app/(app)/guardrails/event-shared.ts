import { CircleAlert, Eye, ShieldX, WandSparkles } from "lucide-react"
import type { GuardrailConnection, GuardrailContext, GuardrailEvent } from "@/lib/gateway/client"

export const verdicts = {
  reject: { label: "Blocked", icon: ShieldX, variant: "destructive" },
  mask: { label: "Masked", icon: WandSparkles, variant: "secondary" },
  audit: { label: "Audit", icon: Eye, variant: "secondary" },
  failOpen: { label: "Fail open", icon: CircleAlert, variant: "warning" },
} as const

export const detectors: Record<string, string> = {
  regex: "Regular expression",
  openAIModeration: "OpenAI Moderation",
  bedrockGuardrails: "AWS Bedrock Guardrails",
  googleModelArmor: "Google Model Armor",
  webhook: "Custom webhook",
}

export const detectorProviders: Partial<
  Record<GuardrailEvent["evaluation"]["guard"], GuardrailConnection["provider"]>
> = {
  openAIModeration: "OpenAI",
  bedrockGuardrails: "Bedrock",
  googleModelArmor: "ModelArmor",
  webhook: "Webhook",
}

export const contentScopes: Record<GuardrailContext["scopes"][number], string> = {
  instructions: "System instructions",
  conversation: "Chat messages",
  toolArguments: "Tool inputs",
  toolResults: "Tool results",
}
