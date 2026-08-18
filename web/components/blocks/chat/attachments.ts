"use client"

import type { PromptInputFile } from "@/components/ai-elements/prompt-input"
import { writeAgentFileRaw } from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { formatByteSize } from "@/lib/format"
import type { Part, TextPartInput } from "@opencode-ai/sdk/v2"
import { nanoid } from "nanoid"
import * as z from "zod"

export const chatAttachmentConfig = {
  maxFileCount: 3,
  maxFileSizeBytes: 8 * 1024 * 1024,
} as const

const chatAttachmentSchema = z.object({
  filename: z.string().min(1),
  id: z.string().min(1),
  mediaType: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
})

export type ChatAttachment = z.infer<typeof chatAttachmentSchema>

const attachmentPartSchema = z.object({
  agentz_attachment: chatAttachmentSchema,
})

export function chatAttachmentErrorMessage(code: "max_file_size" | "max_files") {
  switch (code) {
    case "max_file_size":
      return `Each attachment must be ${formatByteSize(chatAttachmentConfig.maxFileSizeBytes)} or smaller.`
    case "max_files":
      return `You can attach up to ${chatAttachmentConfig.maxFileCount} files per message.`
  }
}

export async function uploadChatAttachments(
  agentName: string,
  workspaceId: string,
  sessionID: string,
  files: PromptInputFile[]
): Promise<ChatAttachment[]> {
  if (files.length > chatAttachmentConfig.maxFileCount) {
    throw new Error(chatAttachmentErrorMessage("max_files"))
  }
  for (const file of files) {
    if (file.size > chatAttachmentConfig.maxFileSizeBytes) {
      throw new Error(chatAttachmentErrorMessage("max_file_size"))
    }
  }

  const hasLocalFiles = files.some((file) => file.source === "local")
  const baseUrl = hasLocalFiles ? await getGatewayBaseURL() : undefined
  const uploadID = nanoid()
  const uploadNames = new Set<string>()
  return Promise.all(
    files.map(async (item) => {
      if (item.source === "workspace") {
        return {
          filename: item.filename,
          id: nanoid(),
          mediaType: item.mediaType,
          path: item.path,
          size: item.size,
        }
      }

      if (!baseUrl) throw new Error("Gateway URL is unavailable")

      const id = nanoid()
      const sanitized = item.filename.replaceAll(/[/\\\u0000-\u001f\u007f]/g, "_")
      let filename =
        sanitized.length === 0 || sanitized === "." || sanitized === ".." ? "attachment" : sanitized
      if (uploadNames.has(filename)) {
        filename = `${id}-${filename}`
      }
      uploadNames.add(filename)
      const path = `.agentz/attachments/${sessionID}/${uploadID}/${filename}`
      const result = await writeAgentFileRaw({
        baseUrl,
        body: item.file,
        headers: { "X-AgentZ-Workspace-ID": workspaceId },
        path: { agentName },
        query: { path },
      })
      if (result.error || !result.data) {
        throw new Error(result.error?.message ?? `Failed to upload ${item.filename}`)
      }

      return {
        filename: item.filename,
        id,
        mediaType: item.mediaType,
        path: result.data.path,
        size: result.data.size,
      }
    })
  )
}

export function opencodePartsFromMessage(
  text: string,
  attachments: ChatAttachment[]
): TextPartInput[] {
  const parts: TextPartInput[] = attachments.map(
    (attachment) =>
      ({
        metadata: { agentz_attachment: attachment },
        synthetic: true,
        text: [
          "<attached_file>",
          `path: ${JSON.stringify(`/home/agentz/${attachment.path}`)}`,
          `name: ${JSON.stringify(attachment.filename)}`,
          `media_type: ${JSON.stringify(attachment.mediaType)}`,
          `size: ${attachment.size} bytes`,
          "The path is exact. Copy it verbatim; do not shorten or remove directories.",
          "Use analyze_file when you need the contents of this file.",
          "</attached_file>",
        ].join("\n"),
        type: "text",
      }) satisfies TextPartInput
  )

  if (text.length > 0) {
    parts.push({ text, type: "text" })
  }

  return parts
}

export function attachmentFromPart(
  part: Extract<Part, { type: "text" }>
): ChatAttachment | undefined {
  if (part.synthetic !== true) return undefined

  const result = attachmentPartSchema.safeParse(part.metadata)
  if (!result.success) return undefined

  return result.data.agentz_attachment
}

export function promptFileFromPart(
  part: Extract<Part, { type: "text" }>
): PromptInputFile | undefined {
  const attachment = attachmentFromPart(part)
  if (!attachment) return undefined

  return {
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    path: attachment.path,
    size: attachment.size,
    source: "workspace",
    type: "file",
  }
}
