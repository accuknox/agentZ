import type { Message } from "@opencode-ai/sdk/v2"

// SDK responses wrap the error message in either `data.message` or `message`.
// We normalize to a single string with a sensible fallback so call sites never
// have to repeat the same `?? ` ternary.
export type SdkErrorLike = {
  data?: { message?: string }
  message?: string
  _tag?: unknown
  name?: unknown
}

export function sdkErrorMessage(error: SdkErrorLike | undefined, fallback: string): string {
  return error?.data?.message ?? error?.message ?? fallback
}

// AssistantMessage carries an optional `error` discriminated by `name`. We pull
// out a short label and the provider-authored body so the timeline can render
// a consistent Error/Interrupted row without leaking raw provider JSON.
export type AssistantMessageError = Extract<Message, { role: "assistant" }>["error"]

export function unwrapMessageError(error: AssistantMessageError | undefined): {
  body: string
  interrupted: boolean
  label: string
} {
  if (!error) return { body: "", interrupted: false, label: "" }

  switch (error.name) {
    case "MessageAbortedError": {
      return {
        body: error.data.message || "Run stopped",
        interrupted: true,
        label: "Interrupted",
      }
    }
    case "ProviderAuthError": {
      return {
        body: error.data.message || "Check provider credentials",
        interrupted: false,
        label: "Authentication failed",
      }
    }
    case "ContextOverflowError": {
      return {
        body: error.data.message || "Compact the session to continue",
        interrupted: false,
        label: "Context limit exceeded",
      }
    }
    case "MessageOutputLengthError":
      return {
        body: "Response exceeded the model output limit",
        interrupted: false,
        label: "Output limit hit",
      }
    case "ContentFilterError": {
      return {
        body: error.data.message || "Blocked by provider safety filter",
        interrupted: false,
        label: "Content filtered",
      }
    }
    case "StructuredOutputError": {
      return {
        body: error.data.message || "Schema validation retry exhausted",
        interrupted: false,
        label: "Structured output failed",
      }
    }
    case "APIError": {
      return {
        body: error.data.message || "The provider rejected the request",
        interrupted: false,
        label: error.data.statusCode ? `Provider error ${error.data.statusCode}` : "Provider error",
      }
    }
    case "UnknownError":
    default: {
      return {
        body: error.data.message || "An unexpected error occurred",
        interrupted: false,
        label: "Session error",
      }
    }
  }
}
