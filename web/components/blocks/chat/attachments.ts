"use client"

import type { AttachmentData } from "@/components/ai-elements/attachments"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input"
import type { FilePartInput, Part, TextPartInput } from "@opencode-ai/sdk/v2"

export const chatAttachmentConfig = {
  accept: "image/*,application/pdf",
  maxFileCount: 3,
  maxFileSizeBytes: 3 * 1024 * 1024,
} as const

export type ChatAttachment = PromptInputMessage["files"][number]
export type ChatMessagePart = FilePartInput | TextPartInput

const blockedMimeTypes = new Set(["image/svg+xml"])

function inferDataURLSize(value: string) {
  const comma = value.indexOf(",")
  if (comma < 0) return 0

  const encoded = value.slice(comma + 1)
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding)
}

export function chatAttachmentErrorMessage(code: "accept" | "max_file_size" | "max_files") {
  switch (code) {
    case "accept":
      return "Only images and PDFs are supported. SVG files are blocked."
    case "max_file_size":
      return `Each attachment must be ${formatBytes(chatAttachmentConfig.maxFileSizeBytes)} or smaller.`
    case "max_files":
      return `You can attach up to ${chatAttachmentConfig.maxFileCount} files per message.`
  }
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function validateChatAttachments(files: ChatAttachment[]) {
  if (files.length > chatAttachmentConfig.maxFileCount) {
    throw new Error(chatAttachmentErrorMessage("max_files"))
  }

  for (const file of files) {
    const mime = file.mediaType?.trim()
    if (!mime) {
      throw new Error("Attachment is missing a media type")
    }
    if (blockedMimeTypes.has(mime) || (!mime.startsWith("image/") && mime !== "application/pdf")) {
      throw new Error(chatAttachmentErrorMessage("accept"))
    }
    if (!file.url.startsWith("data:") || !file.url.includes(";base64,")) {
      throw new Error("Attachment content is invalid")
    }

    const size = typeof file.size === "number" ? file.size : inferDataURLSize(file.url)
    if (size > chatAttachmentConfig.maxFileSizeBytes) {
      throw new Error(chatAttachmentErrorMessage("max_file_size"))
    }
  }
}

export function messageHasRenderableContent(
  text: string,
  attachments: readonly AttachmentData[] | readonly ChatAttachment[]
) {
  return text.trim().length > 0 || attachments.length > 0
}

export function opencodePartsFromMessage(message: PromptInputMessage): ChatMessagePart[] {
  validateChatAttachments(message.files)

  const parts: ChatMessagePart[] = message.files.map((file) => {
    const mime = file.mediaType?.trim()
    if (!mime) {
      throw new Error("Attachment is missing a media type")
    }

    const part = {
      filename: file.filename,
      mime,
      type: "file",
      url: file.url,
    } satisfies FilePartInput

    return part
  })

  if (message.text.trim().length > 0) {
    parts.push({
      text: message.text,
      type: "text",
    })
  }

  return parts
}

export function attachmentDataFromPart(
  part: Extract<Part, { type: "file" }> | FilePartInput
): AttachmentData {
  return {
    filename: part.filename,
    id: part.id ?? `attachment-${crypto.randomUUID()}`,
    mediaType: part.mime,
    type: "file",
    url: part.url,
  }
}
