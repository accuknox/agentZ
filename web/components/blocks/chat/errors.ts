import { zGuardrailError, zGuardrailRejection } from "@/lib/gateway/client/zod.gen"

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
      if (error.data.responseBody) {
        let body: unknown
        try {
          body = JSON.parse(error.data.responseBody)
        } catch {
          // A provider may return plain text instead of a JSON error.
        }
        const rejection = zGuardrailRejection
          .transform((value) => value.error)
          .or(zGuardrailError.omit({ type: true }).partial({ guardrail: true }))
          .safeParse(body)
        if (rejection.success) {
          const context = rejection.data.guardrail
          if (!context) {
            return {
              body: rejection.data.message,
              guardrail: true,
              label:
                rejection.data.code === "guardrail_unavailable"
                  ? "Guardrail checker unavailable"
                  : "Blocked by policy",
            }
          }
          const scopes = {
            instructions: "System instructions",
            conversation:
              context.phase === "request" ? "Conversation input" : "Conversation output",
            toolArguments: "Tool arguments",
            toolResults: "Tool results",
          }
          const label =
            context.reason === "checker_error"
              ? "Guardrail checker unavailable"
              : "Blocked by policy"
          const content = context.matchedScope
            ? scopes[context.matchedScope]
            : context.scopes.map((scope) => scopes[scope]).join(", ")
          return {
            body: rejection.data.message,
            guardrail: true,
            label: content ? `${label} · ${content}` : label,
          }
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
      // OpenCode serializes AI SDK stream errors after the SDK drops extension fields.
      let body: unknown
      try {
        body = JSON.parse(error.data.message)
      } catch {
        // Other UnknownError messages are ordinary text.
      }
      const streamed = zGuardrailError.omit({ guardrail: true }).safeParse(body)
      if (streamed.success) {
        return {
          body: streamed.data.message,
          guardrail: true,
          label:
            streamed.data.code === "guardrail_unavailable"
              ? "Guardrail checker unavailable"
              : "Blocked by policy",
        }
      }
      return {
        body: error.data.message || "An unexpected error occurred",
        label: "Session error",
      }
    }
  }
}
