import { CheckCircle2, CircleAlert, Eye, ShieldX, WandSparkles } from "lucide-react"
import type { GuardrailContext } from "@/lib/gateway/client"

export const verdicts = {
  allow: { label: "Allowed", icon: CheckCircle2, variant: "success" },
  reject: { label: "Blocked", icon: ShieldX, variant: "destructive" },
  mask: { label: "Masked", icon: WandSparkles, variant: "secondary" },
  audit: { label: "Audit finding", icon: Eye, variant: "secondary" },
  failOpen: { label: "Fail open", icon: CircleAlert, variant: "warning" },
} as const

export const detectors: Record<string, string> = {
  regex: "Regular expression",
  openAIModeration: "OpenAI Moderation",
  bedrockGuardrails: "AWS Bedrock Guardrails",
  googleModelArmor: "Google Model Armor",
  webhook: "Custom webhook",
}

export const contentScopes: Record<GuardrailContext["scopes"][number], string> = {
  instructions: "System instructions",
  conversation: "Chat messages",
  toolArguments: "Tool inputs",
  toolResults: "Tool results",
}
