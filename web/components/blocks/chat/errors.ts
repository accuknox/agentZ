import { zGuardrailError, zGuardrailRejection } from "@/lib/gateway/client/zod.gen"
import type { GuardrailError } from "@/lib/gateway/client"

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

function describeGuardrailError(
  error: Pick<GuardrailError, "code" | "message"> & Partial<Pick<GuardrailError, "guardrail">>
) {
  const context = error.guardrail
  const unavailable = error.code === "guardrail_unavailable" || context?.reason === "checker_error"
  if (unavailable) {
    return { body: error.message, guardrail: true, label: "Guardrail checker unavailable" }
  }
  if (!context) return { body: "", guardrail: true, label: error.message || "Blocked by policy" }

  const scopes = {
    instructions: "System instructions",
    conversation: context.phase === "request" ? "Chat messages" : "Assistant response",
    toolArguments: "Tool inputs",
    toolResults: "Tool results",
  }
  const scope =
    context.matchedScope ?? (context.scopes.length === 1 ? context.scopes[0] : undefined)
  const content = scope
    ? scopes[scope]
    : context.phase === "request"
      ? "Model request"
      : "Model response"
  const policy = context.policyName || context.policyId
  const label = policy
    ? `${content} blocked by policy named ${JSON.stringify(policy)}`
    : `${content} blocked by policy`
  return { body: context.message, guardrail: true, label }
}

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
          return describeGuardrailError(rejection.data)
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
      const streamed = zGuardrailError
        .partial({ guardrail: true })
        .or(zGuardrailError.omit({ guardrail: true }))
        .safeParse(body)
      if (streamed.success) {
        return describeGuardrailError(streamed.data)
      }
      return {
        body: error.data.message || "An unexpected error occurred",
        label: "Session error",
      }
    }
  }
}
