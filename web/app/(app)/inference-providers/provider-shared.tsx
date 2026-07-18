"use client"

import {
  AmazonWebServicesDark,
  AmazonWebServicesLight,
  AnthropicDark,
  AnthropicLight,
  Gemini,
  GoogleCloud,
  MicrosoftAzure,
  OpenAIDark,
  OpenAILight,
} from "@ridemountainpig/svgl-react"
import { Cloud } from "lucide-react"
import type { InferenceProviderType } from "@/lib/gateway/client"

/** providerTypes enumerates every backend the provider form can configure. */
export const providerTypes = [
  "OpenAI",
  "Anthropic",
  "Gemini",
  "VertexAI",
  "Bedrock",
  "Azure",
  "OpenAICompatible",
] as const satisfies readonly InferenceProviderType[]

/** providerTypeLabels maps backend identifiers to their marketing names. */
export const providerTypeLabels: Record<InferenceProviderType, string> = {
  OpenAI: "OpenAI",
  Anthropic: "Anthropic",
  Gemini: "Google Gemini",
  VertexAI: "Google Vertex AI",
  Bedrock: "Amazon Bedrock",
  Azure: "Microsoft Azure",
  OpenAICompatible: "OpenAI-compatible",
}

/**
 * ProviderIcon renders the vendor logo for a provider type. Logos with poor
 * contrast on dark surfaces ship a dedicated dark variant that is swapped in
 * with CSS so both stay in the DOM for instant theme switches. Icons are
 * decorative: adjacent text always carries the provider name.
 */
export function ProviderIcon({
  type,
  className = "size-5",
}: {
  type: InferenceProviderType
  className?: string
}) {
  if (type === "OpenAI") {
    return (
      <>
        <OpenAILight aria-hidden className={`${className} dark:hidden`} />
        <OpenAIDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (type === "Anthropic") {
    return (
      <>
        <AnthropicLight aria-hidden className={`${className} dark:hidden`} />
        <AnthropicDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (type === "Gemini") return <Gemini aria-hidden className={className} />
  if (type === "VertexAI") return <GoogleCloud aria-hidden className={className} />
  if (type === "Bedrock") {
    return (
      <>
        <AmazonWebServicesLight aria-hidden className={`${className} dark:hidden`} />
        <AmazonWebServicesDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (type === "Azure") return <MicrosoftAzure aria-hidden className={className} />
  return <Cloud aria-hidden className={className} />
}
