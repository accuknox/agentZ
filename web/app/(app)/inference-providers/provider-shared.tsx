"use client"

import { useState } from "react"
import {
  AmazonWebServicesDark,
  AmazonWebServicesLight,
  AnthropicDark,
  AnthropicLight,
  Cloudflare,
  Gemini,
  GoogleCloud,
  Meta,
  MicrosoftAzure,
  OpenAIDark,
  OpenAILight,
  XAIDark,
  XAILight,
} from "@ridemountainpig/svgl-react"
import { Cloud } from "lucide-react"
import type { InferenceProviderKind } from "@/lib/gateway/client"

/** providerKindLabels describes the configuration selected by each kind. */
export const providerKindLabels: Record<InferenceProviderKind, string> = {
  OpenAI: "OpenAI",
  Anthropic: "Anthropic",
  Gemini: "Google Gemini",
  OpenAICompatible: "OpenAI-compatible",
  AnthropicCompatible: "Anthropic-compatible",
  Bedrock: "Amazon Bedrock",
  VertexAI: "Google Vertex AI",
  Azure: "Microsoft Azure",
}

/** ProviderIcon renders provider branding independently of configuration kind. */
export function ProviderIcon({
  provider,
  className = "size-5",
}: {
  provider: string
  className?: string
}) {
  const [failedProvider, setFailedProvider] = useState<string | null>(null)

  if (provider === "openai") {
    return (
      <>
        <OpenAILight aria-hidden className={`${className} dark:hidden`} />
        <OpenAIDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "anthropic") {
    return (
      <>
        <AnthropicLight aria-hidden className={`${className} dark:hidden`} />
        <AnthropicDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "google") return <Gemini aria-hidden className={className} />
  if (provider.startsWith("google-vertex")) {
    return <GoogleCloud aria-hidden className={className} />
  }
  if (provider === "amazon-bedrock") {
    return (
      <>
        <AmazonWebServicesLight aria-hidden className={`${className} dark:hidden`} />
        <AmazonWebServicesDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "azure" || provider === "azure-cognitive-services") {
    return <MicrosoftAzure aria-hidden className={className} />
  }
  if (provider === "xai") {
    return (
      <>
        <XAILight aria-hidden className={`${className} dark:hidden`} />
        <XAIDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider.startsWith("cloudflare-")) {
    return <Cloudflare aria-hidden className={className} />
  }
  if (provider === "meta" || provider === "llama") {
    return <Meta aria-hidden className={className} />
  }
  if (provider === "custom") return <Cloud aria-hidden className={className} />

  if (failedProvider === provider) {
    return <Cloud aria-hidden className={className} />
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny external provider SVG
    <img
      aria-hidden
      alt=""
      className={`${className} shrink-0 dark:invert`}
      height={20}
      src={`https://models.dev/logos/${provider}.svg`}
      width={20}
      onError={() => {
        setFailedProvider(provider)
      }}
    />
  )
}
