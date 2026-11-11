import { z } from "zod"
import type { AppOperationResponse, AppSpan, Span, SpanRecording } from "@/lib/gateway/client"

// These are the text-bearing fields of Messages, Chat Completions, and
// Responses requests. Provider extensions stay in the original span payload.
const textBlock = z.object({ type: z.string(), text: z.string().optional() })
const messageContent = z.union([
  z.string().transform((text) => [text]),
  z
    .array(textBlock)
    .transform((blocks) =>
      blocks.flatMap((block) =>
        ["text", "input_text", "output_text"].includes(block.type) && block.text ? [block.text] : []
      )
    ),
])
const message = z.union([
  z
    .object({
      role: z.string(),
      parts: z.array(z.object({ type: z.string(), content: z.string().optional() })),
    })
    .transform((message) => ({
      role: message.role,
      content: message.parts.flatMap((part) =>
        part.type === "text" && part.content ? [part.content] : []
      ),
    })),
  z.object({ role: z.string().optional(), content: messageContent.nullish() }),
])
const messages = z.array(message)
const request = z.union([
  messages,
  z.object({ messages }).transform((input) => input.messages),
  z.object({ input: messages }).transform((input) => input.input),
  z.object({ input: z.string() }).transform((input) => [{ role: "user", content: [input.input] }]),
])
const response = z.union([
  z.object({ completion: z.array(z.string()) }).transform((output) => output.completion),
  messages.transform((output) =>
    output.flatMap((message) => (message.role === "assistant" ? (message.content ?? []) : []))
  ),
])
const toolContent = z.union([
  z.string(),
  z
    .array(
      z.strictObject({ type: z.enum(["text", "input_text", "output_text"]), text: z.string() })
    )
    .min(1)
    .transform((blocks) => blocks.map((block) => block.text).join("\n\n")),
])

type RecordedContent = { format: "json" | "text"; text: string }

export type RecordedStep = {
  key: string
  span: AppSpan | Span
} & (
  | { kind: "prompt"; text: string; context: string[] }
  | { kind: "response"; text: string }
  | {
      kind: "tool"
      arguments: RecordedContent
      result?: RecordedContent
      error?: RecordedContent
    }
)

/**
 * readTraceRecording uses observed responses as new activity. Repeated request
 * history is context, never another execution or another assistant reply.
 */
export function readTraceRecording(
  operations: (AppOperationResponse | SpanRecording)[]
): RecordedStep[] {
  const steps: RecordedStep[] = []

  for (const operation of operations) {
    const { span, payload } = operation

    if (span.span_class === "tool") {
      const args = readToolContent(payload.tool_arguments, "arguments")
      steps.push({
        key: `tool:${span.id}`,
        kind: "tool",
        span,
        arguments: args ?? { format: "text", text: "_" },
        result: readToolContent(payload.tool_result, "result"),
        error: readToolContent(operation.tool_error, "error"),
      })
      continue
    }

    if (span.span_class !== "llm" && span.operation_name !== "observe_context") continue
    if (payload.input_messages !== "null") {
      const input = request.safeParse(JSON.parse(payload.input_messages))
      if (input.success) {
        const texts = input.data.findLast((message) => message.role === "user")?.content ?? []
        const context: string[] = []
        const visible: string[] = []
        for (const text of texts) {
          const wrapper =
            /^(?:<system-reminder>|<local-command-caveat>|<command-name>|<command-message>|<local-command-stdout>)/u.test(
              text.trimStart()
            )
          if (wrapper) {
            context.push(text)
            continue
          }
          visible.push(text)
        }
        const text = visible.join("\n\n").trim()
        if (text || context.length)
          steps.push({ key: `prompt:${span.id}`, kind: "prompt", span, text, context })
      }
    }

    if (span.operation_name === "observe_context") continue
    const output = response.safeParse(JSON.parse(payload.output_messages))
    steps.push({
      key: `response:${span.id}`,
      kind: "response",
      span,
      text: output.success ? output.data.filter(Boolean).join("\n\n") : "",
    })
  }
  return steps
}

/** Read scalar and text-only tool results without dropping structured evidence. */
export function readToolContent(
  raw: string,
  kind: "arguments" | "result" | "error"
): RecordedContent | undefined {
  if (raw === "null") return undefined
  const value: unknown = JSON.parse(raw)
  const text = (kind === "result" ? toolContent : z.string()).safeParse(value)
  if (text.success) return { format: "text", text: text.data }
  // Keep the serialized bytes, including integers beyond JavaScript precision.
  return { format: "json", text: raw }
}
