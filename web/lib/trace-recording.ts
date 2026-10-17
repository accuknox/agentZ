import { z } from "zod"
import type { AppOperationResponse, AppSpan } from "@/lib/gateway/client"

// These are the text-bearing fields of Messages, Chat Completions, and
// Responses requests. Provider extensions stay in the original span payload.
const textBlock = z.object({ type: z.string(), text: z.string().optional() })
const messageContent = z.union([
  z.string().transform((text) => [text]),
  z
    .array(textBlock)
    .transform((blocks) =>
      blocks
        .filter((block) => ["text", "input_text", "output_text"].includes(block.type))
        .flatMap((block) => (block.text ? [block.text] : []))
    ),
])
const message = z.object({ role: z.string().optional(), content: messageContent.nullish() })
const request = z.union([
  z.object({ messages: z.array(message) }).transform((input) => input.messages),
  z.object({ input: z.array(message) }).transform((input) => input.input),
  z.object({ input: z.string() }).transform((input) => [{ role: "user", content: [input.input] }]),
])
const response = z.object({ completion: z.array(z.string()) })
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
  span: AppSpan
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
  operations: AppOperationResponse[],
  includePrompt: boolean
): RecordedStep[] {
  const steps: RecordedStep[] = []
  let promptRead = !includePrompt

  for (const operation of operations) {
    const { span, payload } = operation
    if (span.resource_kind === "turn") continue

    if (span.resource_kind === "tool" || span.resource_kind === "mcp") {
      const args = readToolContent(payload.tool_arguments, "arguments")
      steps.push({
        key: `tool:${span.id}`,
        kind: "tool",
        span,
        arguments: args ?? { format: "text", text: "Arguments not captured" },
        result: readToolContent(payload.tool_result, "result"),
        error: readToolContent(operation.tool_error, "error"),
      })
      continue
    }

    if (span.resource_kind !== "inference") continue
    if (!promptRead) {
      promptRead = true
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

    const output = response.safeParse(JSON.parse(payload.output_messages))
    steps.push({
      key: `response:${span.id}`,
      kind: "response",
      span,
      text: output.success ? output.data.completion.filter(Boolean).join("\n\n") : "",
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
