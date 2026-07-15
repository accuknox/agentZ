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
  if ("message" in error) return error.message
  if ("data" in error) return error.data.message
  return fallback
}

// AssistantMessage carries an optional error discriminated by name. Keep the
// provider detail while giving every SDK variant a stable user-facing label.
export function describeMessageError(error: AssistantMessage["error"]): {
  body: string
  label: string
} {
  if (!error) {
    return {
      body: "An unexpected error occurred",
      label: "Session error",
    }
  }

  switch (error.name) {
    case "MessageAbortedError": {
      return {
        body: error.data.message || "Run stopped",
        label: "Interrupted",
      }
    }
    case "ProviderAuthError": {
      return {
        body: error.data.message || "Check provider credentials",
        label: "Authentication failed",
      }
    }
    case "ContextOverflowError": {
      return {
        body: error.data.message || "Compact the session to continue",
        label: "Context limit exceeded",
      }
    }
    case "MessageOutputLengthError":
      return {
        body: "Response exceeded the model output limit",
        label: "Output limit hit",
      }
    case "ContentFilterError": {
      return {
        body: error.data.message || "Blocked by provider safety filter",
        label: "Content filtered",
      }
    }
    case "StructuredOutputError": {
      return {
        body: error.data.message || "Schema validation retry exhausted",
        label: "Structured output failed",
      }
    }
    case "APIError": {
      return {
        body: error.data.message || "The provider rejected the request",
        label: error.data.statusCode ? `Provider error ${error.data.statusCode}` : "Provider error",
      }
    }
    case "UnknownError": {
      return {
        body: error.data.message || "An unexpected error occurred",
        label: "Session error",
      }
    }
  }
}
