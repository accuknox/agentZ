"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SourceDocumentUIPart } from "ai"
import {
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  Music2Icon,
  PaperclipIcon,
  VideoIcon,
  XIcon,
} from "lucide-react"
import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { createContext, useContext, useMemo } from "react"

// ============================================================================
// Types
// ============================================================================

type FileAttachmentBase = {
  filename: string
  id: string
  mediaType: string
  size?: number
  type: "file"
}

type AgentFileAttachmentData = FileAttachmentBase & {
  path: string
  url?: string
}

type BrowserFileAttachmentData = FileAttachmentBase & {
  path?: never
  url: string
}

type FileAttachmentData = AgentFileAttachmentData | BrowserFileAttachmentData

type AttachmentData =
  | FileAttachmentData
  | (SourceDocumentUIPart & {
      id: string
    })

type AttachmentMediaCategory = "image" | "video" | "audio" | "document" | "source" | "unknown"

type AttachmentVariant = "composer" | "grid" | "inline" | "list" | "wide"

const mediaCategoryIcons: Record<AttachmentMediaCategory, typeof ImageIcon> = {
  audio: Music2Icon,
  document: FileTextIcon,
  image: ImageIcon,
  source: GlobeIcon,
  unknown: PaperclipIcon,
  video: VideoIcon,
}

const mediaTypesByExtension: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
}

const spreadsheetExtensions = new Set(["csv", "ods", "xls", "xlsx"])

function getFileExtension(filename: string) {
  const dot = filename.lastIndexOf(".")
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : ""
}

export function inferAttachmentMediaType(filename: string, mediaType?: string) {
  const normalized = mediaType?.trim()
  if (normalized && normalized !== "application/octet-stream") return normalized
  return (
    mediaTypesByExtension[getFileExtension(filename)] ?? normalized ?? "application/octet-stream"
  )
}

export function getAttachmentMediaCategory(data: AttachmentData): AttachmentMediaCategory {
  if (data.type === "source-document") {
    return "source"
  }

  const mediaType = inferAttachmentMediaType(data.filename, data.mediaType)

  if (mediaType.startsWith("image/")) {
    return "image"
  }
  if (mediaType.startsWith("video/")) {
    return "video"
  }
  if (mediaType.startsWith("audio/")) {
    return "audio"
  }
  if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
    return "document"
  }

  return "unknown"
}

type FilePresentation = {
  color: string
  logo: "document" | "image" | "spreadsheet"
}

function getFilePresentation(data: AttachmentData): FilePresentation {
  if (data.type !== "file") {
    return { color: "bg-sky-500", logo: "document" }
  }

  const extension = getFileExtension(data.filename)
  const mediaType = inferAttachmentMediaType(data.filename, data.mediaType)
  if (mediaType.startsWith("image/")) {
    return { color: "bg-[#3973e6]", logo: "image" }
  }

  if (mediaType === "application/pdf") {
    return { color: "bg-[#f43f47]", logo: "document" }
  }

  if (
    spreadsheetExtensions.has(extension) ||
    mediaType.includes("excel") ||
    mediaType.includes("spreadsheet")
  ) {
    return { color: "bg-[#45ad57]", logo: "spreadsheet" }
  }

  return {
    color: "bg-[#737780]",
    logo: "document",
  }
}

function getFileTypeLabel(data: AttachmentData) {
  if (data.type !== "file") return "Source"

  const extension = getFileExtension(data.filename).toUpperCase()
  const presentation = getFilePresentation(data)
  const category =
    presentation.logo === "spreadsheet"
      ? "Spreadsheet"
      : presentation.logo === "image"
        ? "Image"
        : "Document"

  return extension ? `${category} · ${extension}` : category
}

function FileTypeLogo({ type }: { type: FilePresentation["logo"] }) {
  if (type === "image") {
    return <ImageIcon aria-hidden="true" className="size-7" strokeWidth={1.8} />
  }

  if (type === "spreadsheet") {
    return (
      <svg aria-hidden="true" className="size-[19px]" fill="none" viewBox="0 0 28 28">
        <rect
          height="19"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="2.2"
          width="17"
          x="5.5"
          y="4.5"
        />
        <path
          d="M6.5 10.5h15M11.5 10.5v12M16.5 10.5v12M6.5 16.5h15"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    )
  }

  return (
    <svg aria-hidden="true" className="size-[19px]" fill="none" viewBox="0 0 28 28">
      <path
        d="M8 3.75h8.2L21.5 9v14.25A1.75 1.75 0 0 1 19.75 25h-11.5a1.75 1.75 0 0 1-1.75-1.75V5.5A1.75 1.75 0 0 1 8.25 3.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <path d="M16 4v5.5h5.25" stroke="currentColor" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  )
}

const renderAttachmentImage = (
  url: string,
  filename: string | undefined,
  variant: AttachmentVariant
) =>
  variant === "grid" || variant === "composer" ? (
    // eslint-disable-next-line @next/next/no-img-element -- user-uploaded blob/data URL, not optimizable by Next.js
    <img
      alt={variant === "grid" ? filename || "Image" : ""}
      className="size-full object-cover"
      height={96}
      loading={variant === "grid" ? "lazy" : undefined}
      src={url}
      width={96}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- user-uploaded blob/data URL, not optimizable by Next.js
    <img alt="" className="size-full rounded object-cover" height={20} src={url} width={20} />
  )

// ============================================================================
// Contexts
// ============================================================================

const AttachmentsContext = createContext<AttachmentVariant>("grid")

interface AttachmentContextValue {
  data: AttachmentData
  mediaCategory: AttachmentMediaCategory
  onRemove?: () => void
  variant: AttachmentVariant
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null)

// ============================================================================
// Hooks
// ============================================================================

const useAttachmentContext = () => {
  const ctx = useContext(AttachmentContext)
  if (!ctx) {
    throw new Error("Attachment components must be used within <Attachment>")
  }
  return ctx
}

// ============================================================================
// Attachments - Container
// ============================================================================

type AttachmentsProps = HTMLAttributes<HTMLElement> & {
  variant?: AttachmentVariant
}

export const Attachments = ({
  variant = "grid",
  className,
  children,
  ...props
}: AttachmentsProps) => {
  const Root = variant === "wide" ? "span" : "div"

  return (
    <AttachmentsContext.Provider value={variant}>
      <Root
        className={cn(
          "flex items-start",
          variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2",
          variant === "grid" && "ml-auto w-fit",
          className
        )}
        {...props}
      >
        {children}
      </Root>
    </AttachmentsContext.Provider>
  )
}

// ============================================================================
// Attachment - Item
// ============================================================================

type AttachmentProps = HTMLAttributes<HTMLElement> & {
  data: AttachmentData
  onOpen?: () => void
  onRemove?: () => void
}

export const Attachment = ({
  data,
  onOpen,
  onRemove,
  className,
  children,
  ...props
}: AttachmentProps) => {
  const variant = useContext(AttachmentsContext)
  const mediaCategory = getAttachmentMediaCategory(data)
  const Root = variant === "wide" ? "span" : "div"

  const contextValue = useMemo<AttachmentContextValue>(
    () => ({ data, mediaCategory, onRemove, variant }),
    [data, mediaCategory, onRemove, variant]
  )

  return (
    <AttachmentContext.Provider value={contextValue}>
      <Root
        className={cn(
          "group relative",
          variant === "grid" && "size-24 overflow-hidden rounded-lg",
          variant === "composer" && [
            "border-border/80 bg-background flex h-[120px] w-[132px] min-w-0 flex-col items-start",
            "rounded-xl border p-2.5 shadow-[0_2px_8px_rgb(0_0_0/0.05)] select-none",
            onOpen &&
              "hover:bg-accent/40 cursor-pointer transition-colors motion-reduce:transition-none",
          ],
          variant === "inline" && [
            "flex h-10 max-w-72 cursor-pointer items-center gap-2 select-none",
            "border-border bg-background rounded-lg border px-2",
            "text-sm font-medium transition-[background-color,border-color,color] motion-reduce:transition-none",
            "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
          ],
          variant === "list" && [
            "flex w-full items-center gap-3 rounded-lg border p-3",
            "hover:bg-accent/50",
          ],
          variant === "wide" && [
            "border-border bg-background flex h-[72px] w-full items-center gap-3 rounded-xl border px-3",
            "shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition-[background-color,border-color] motion-reduce:transition-none",
            "hover:border-foreground/20 hover:bg-accent/40",
          ],
          className
        )}
        {...props}
      >
        {onOpen ? (
          <button
            aria-label={data.type === "file" ? `Preview ${data.filename}` : "Preview attachment"}
            className="focus-visible:ring-ring absolute inset-0 z-[1] cursor-pointer touch-manipulation rounded-[inherit] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            onClick={onOpen}
            type="button"
          />
        ) : null}
        {children}
        {variant === "inline" && data.type === "file" ? (
          <span className="min-w-0 flex-1 truncate" translate="no">
            {data.filename}
          </span>
        ) : null}
        {variant === "composer" && data.type === "file" ? (
          <span
            className="mt-1.5 line-clamp-2 min-w-0 text-[13px] leading-[17px] font-medium"
            translate="no"
          >
            {data.filename}
          </span>
        ) : null}
        {variant === "wide" && data.type === "file" ? (
          <span className="min-w-0 flex-1" translate="no">
            <span className="block truncate text-sm leading-5 font-semibold">{data.filename}</span>
            <span className="text-muted-foreground mt-0.5 block text-xs leading-4">
              {getFileTypeLabel(data)}
            </span>
          </span>
        ) : null}
      </Root>
    </AttachmentContext.Provider>
  )
}

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

type AttachmentPreviewProps = HTMLAttributes<HTMLElement> & {
  fallbackIcon?: ReactNode
}

export const AttachmentPreview = ({
  fallbackIcon,
  className,
  ...props
}: AttachmentPreviewProps) => {
  const { data, mediaCategory, variant } = useAttachmentContext()

  const renderIcon = (Icon: typeof ImageIcon) => (
    <Icon aria-hidden="true" className="text-muted-foreground size-4" />
  )

  const renderContent = () => {
    if (mediaCategory === "image" && data.type === "file" && data.url) {
      return renderAttachmentImage(data.url, data.filename, variant)
    }

    if (mediaCategory === "video" && data.type === "file" && data.url) {
      return <video aria-hidden="true" className="size-full object-cover" muted src={data.url} />
    }

    if (variant === "composer" || variant === "wide") {
      const presentation = getFilePresentation(data)
      return <FileTypeLogo type={presentation.logo} />
    }

    const Icon = mediaCategoryIcons[mediaCategory]
    return fallbackIcon ?? renderIcon(Icon)
  }

  const presentation = getFilePresentation(data)
  const Root = variant === "wide" ? "span" : "div"

  return (
    <Root
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        variant === "grid" && "bg-muted size-full",
        variant === "composer" && [
          "rounded-lg text-white",
          mediaCategory === "image" || mediaCategory === "video"
            ? "bg-muted h-12 w-full"
            : cn("size-9", presentation.color),
        ],
        variant === "inline" && "bg-muted size-7 rounded-md",
        variant === "list" && "bg-muted size-12 rounded",
        variant === "wide" && ["size-11 rounded-lg text-white", presentation.color],
        className
      )}
      {...props}
    >
      {renderContent()}
    </Root>
  )
}

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

type AttachmentRemoveProps = ComponentProps<typeof Button> & {
  label?: string
}

export const AttachmentRemove = ({
  label = "Remove",
  className,
  children,
  ...props
}: AttachmentRemoveProps) => {
  const { onRemove, variant } = useAttachmentContext()

  if (!onRemove) {
    return null
  }

  return (
    <Button
      aria-label={label}
      className={cn(
        variant === "grid" && [
          "absolute top-2 right-2 size-6 rounded-full p-0",
          "bg-background/80 backdrop-blur-sm",
          "opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none",
          "hover:bg-background",
          "[&>svg]:size-3",
        ],
        variant === "inline" && [
          "size-5 rounded p-0",
          "opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none",
          "[&>svg]:size-2.5",
        ],
        variant === "composer" && [
          "absolute -top-[5px] -right-[5px] z-10 size-[22px] rounded-full p-0",
          "border-border bg-background text-muted-foreground border opacity-100 shadow-sm",
          "hover:bg-accent hover:text-foreground [&>svg]:size-[13px]",
        ],
        variant === "list" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
        variant === "wide" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
        className
      )}
      onClick={onRemove}
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </Button>
  )
}
