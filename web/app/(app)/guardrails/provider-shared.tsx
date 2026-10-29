"use client"

import { Webhook } from "lucide-react"
import Image from "next/image"
import { ProviderIcon } from "@/app/(app)/inference/providers/provider-shared"
import type { GuardrailConnection } from "@/lib/gateway/client"

export const guardrailProviderLabels: Record<GuardrailConnection["provider"], string> = {
  AccuKnox: "AccuKnox prompt firewall",
  OpenAI: "OpenAI moderation",
  Bedrock: "AWS Bedrock Guardrails",
  ModelArmor: "Google Model Armor",
  Webhook: "Custom webhook",
}

const providerLogos = {
  OpenAI: "openai",
  Bedrock: "amazon-bedrock",
  ModelArmor: "google-vertex",
} satisfies Record<Exclude<GuardrailConnection["provider"], "AccuKnox" | "Webhook">, string>

// GuardrailProviderIcon keeps branding consistent across forms, rows, and checks.
export function GuardrailProviderIcon({
  provider,
  className = "size-4 shrink-0",
}: {
  provider: GuardrailConnection["provider"]
  className?: string
}) {
  if (provider === "AccuKnox")
    return (
      <Image
        alt=""
        className={className}
        height={256}
        src="/accuknox.webp"
        unoptimized
        width={256}
      />
    )
  if (provider === "Webhook") return <Webhook aria-hidden className={className} />
  return <ProviderIcon provider={providerLogos[provider]} className={className} />
}
