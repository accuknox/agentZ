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
  guardrail?: boolean
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
      if (error.data.statusCode === 422) {
        const body = error.data.message.replace(/^Unprocessable Entity:\s*/, "")
        // Match the gateway's explicit guardrail prefix. Other 422 responses
        // can be provider validation errors and must keep their own message.
        const guardrail =
          /^(Blocked by guardrail "(?:[^"\\]|\\.)*"(?: in policy "(?:[^"\\]|\\.)*")?)(?:: ([\s\S]*))?$/.exec(
            body
          )
        return {
          body: guardrail ? (guardrail[2] ?? "") : body,
          guardrail: guardrail !== null,
          label: guardrail?.[1] || "Request blocked",
        }
      }
      let label = "Provider error"
      if (error.data.statusCode) label = `Provider error ${error.data.statusCode}`
      return {
        body: error.data.message || "The provider rejected the request",
        label,
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
