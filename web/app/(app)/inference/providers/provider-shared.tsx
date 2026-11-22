"use client"

import { useState } from "react"
import {
  AmazonWebServicesDark,
  AmazonWebServicesLight,
  AnthropicDark,
  AnthropicLight,
  ClaudeAI,
  Cloudflare,
  CodexDark,
  CodexLight,
  Gemini,
  GoogleCloud,
  Meta,
  MicrosoftAzure,
  OpenAIDark,
  OpenAILight,
  XAIDark,
  XAILight,
} from "@ridemountainpig/svgl-react"
import { Cloud, Cpu } from "lucide-react"
import type { InferenceProviderKind } from "@/lib/gateway/client"

const themedIcons = new Map([
  ["amazon-bedrock", { light: AmazonWebServicesLight, dark: AmazonWebServicesDark }],
  ["anthropic", { light: AnthropicLight, dark: AnthropicDark }],
  ["codex", { light: CodexLight, dark: CodexDark }],
  ["openai", { light: OpenAILight, dark: OpenAIDark }],
  ["xai", { light: XAILight, dark: XAIDark }],
])

/** providerKindLabels describes the configuration selected by each kind. */
export const providerKindLabels: Record<InferenceProviderKind, string> = {
  OpenAI: "OpenAI",
  OpenAICodex: "OpenAI Codex",
  ClaudeSubscription: "Claude subscription",
  Anthropic: "Anthropic",
  Gemini: "Google Gemini",
  OpenAICompatible: "OpenAI-compatible",
  AnthropicCompatible: "Anthropic-compatible",
  Bedrock: "Amazon Bedrock",
  VertexAI: "Google Vertex AI",
  Azure: "Microsoft Azure",
}

const subscriptionBrands: Partial<Record<InferenceProviderKind, string>> = {
  OpenAICodex: "codex",
  ClaudeSubscription: "claude",
}

/** ProviderIcon renders the subscription or catalog provider brand. */
export function ProviderIcon({
  provider: catalogProvider,
  kind,
  className = "size-5",
  inverted = false,
}: {
  provider: string
  kind?: InferenceProviderKind
  className?: string
  inverted?: boolean
}) {
  const [failedProvider, setFailedProvider] = useState<string | null>(null)
  const provider = (kind && subscriptionBrands[kind]) ?? catalogProvider
  const icons = themedIcons.get(provider)

  if (icons) {
    const LightIcon = inverted ? icons.dark : icons.light
    const DarkIcon = inverted ? icons.light : icons.dark
    return (
      <>
        <LightIcon aria-hidden className={`${className} dark:hidden`} />
        <DarkIcon aria-hidden className={`hidden ${className} dark:block`} />
      </>
    )
  }
  if (provider === "claude") return <ClaudeAI aria-hidden className={className} />

  if (provider === "google") return <Gemini aria-hidden className={className} />
  if (provider.startsWith("google-vertex")) {
    return <GoogleCloud aria-hidden className={className} />
  }
  if (provider === "azure" || provider === "azure-cognitive-services") {
    return <MicrosoftAzure aria-hidden className={className} />
  }
  if (provider.startsWith("cloudflare-")) {
    return <Cloudflare aria-hidden className={className} />
  }
  if (provider === "meta" || provider === "llama") {
    return <Meta aria-hidden className={className} />
  }
  if (provider === "custom" || failedProvider === provider) {
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

/** ProviderIcons shows each provider that can serve a model, including pool members. */
export function ProviderIcons({
  providers,
  className = "size-4 shrink-0",
}: {
  providers: string[]
  className?: string
}) {
  if (!providers.length) return <Cpu aria-label="Provider unavailable" className={className} />
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {providers.map((provider) => (
        <ProviderIcon key={provider} provider={provider} className={className} />
      ))}
    </span>
  )
}
