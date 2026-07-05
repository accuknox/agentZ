import type {
  AssistantMessage,
  PermissionListError,
  PermissionReplyError,
  QuestionListError,
  QuestionRejectError,
  QuestionReplyError,
  SessionAbortError,
  SessionCreateError,
  SessionGetError,
  SessionListError,
  SessionMessagesError,
  SessionPromptAsyncError,
  SessionRevertError,
  SessionUnrevertError,
} from "@opencode-ai/sdk/v2"

type OpenCodeClientError =
  | PermissionListError
  | PermissionReplyError
  | QuestionListError
  | QuestionRejectError
  | QuestionReplyError
  | SessionAbortError
  | SessionCreateError
  | SessionGetError
  | SessionListError
  | SessionMessagesError
  | SessionPromptAsyncError
  | SessionRevertError
  | SessionUnrevertError

export function opencodeErrorMessage(
  error: OpenCodeClientError | undefined,
  fallback: string
): string {
  if (!error) return fallback
  if ("message" in error && typeof error.message === "string") return error.message
  if ("data" in error && typeof error.data.message === "string") return error.data.message
  return fallback
}

// AssistantMessage carries an optional `error` discriminated by `name`. We pull
// out a short label and the provider-authored body so the timeline can render
// a consistent Error/Interrupted row without leaking raw provider JSON.
export type AssistantMessageError = AssistantMessage["error"]

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
