"use client"

import { useState } from "react"
import {
  AmazonWebServicesDark,
  AmazonWebServicesLight,
  AnthropicDark,
  AnthropicLight,
  Cloudflare,
  Gemini,
  GitHubCopilotDark,
  GitHubCopilotLight,
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
  OpenAICodex: "OpenAI Codex",
  Anthropic: "Anthropic",
  Gemini: "Google Gemini",
  GitHubCopilot: "GitHub Copilot",
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
  inverted = false,
}: {
  provider: string
  className?: string
  inverted?: boolean
}) {
  const [failedProvider, setFailedProvider] = useState<string | null>(null)

  if (provider === "openai") {
    return inverted ? (
      <>
        <OpenAIDark aria-hidden className={`${className} dark:hidden`} />
        <OpenAILight aria-hidden className={`hidden ${className} dark:block`} />
      </>
    ) : (
      <>
        <OpenAILight aria-hidden className={`${className} dark:hidden`} />
        <OpenAIDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "github-copilot") {
    return inverted ? (
      <>
        <GitHubCopilotDark aria-hidden className={`${className} dark:hidden`} />
        <GitHubCopilotLight aria-hidden className={`hidden ${className} dark:block`} />
      </>
    ) : (
      <>
        <GitHubCopilotLight aria-hidden className={`${className} dark:hidden`} />
        <GitHubCopilotDark aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "anthropic") {
    return inverted ? (
      <>
        <AnthropicDark aria-hidden className={`${className} dark:hidden`} />
        <AnthropicLight aria-hidden className={`hidden ${className} dark:block`} />
      </>
    ) : (
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
    return inverted ? (
      <>
        <AmazonWebServicesDark aria-hidden className={`${className} dark:hidden`} />
        <AmazonWebServicesLight aria-hidden className={`hidden ${className} dark:block`} />
      </>
    ) : (
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
    return inverted ? (
      <>
        <XAIDark aria-hidden className={`${className} dark:hidden`} />
        <XAILight aria-hidden className={`hidden ${className} dark:block`} />
      </>
    ) : (
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
      className={`${className} shrink-0 ${inverted ? "invert dark:invert-0" : "dark:invert"}`}
      height={20}
      src={`https://models.dev/logos/${provider}.svg`}
      width={20}
      onError={() => {
        setFailedProvider(provider)
      }}
    />
  )
}
