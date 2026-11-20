"use client"

import {
  Attachment,
  AttachmentPreview,
  Attachments,
  inferAttachmentMediaType,
} from "@/components/ai-elements/attachments"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { useObjectURL } from "@/hooks/use-object-url"
import { readAgentFileRawOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { cn } from "@/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { Film, FolderOpen, LoaderCircle, Play } from "lucide-react"
import type { Parents, Root } from "mdast"
import { useInView } from "motion/react"
import type { ComponentProps, HTMLAttributes, FC, ReactNode } from "react"
import { Children, cloneElement, isValidElement, memo, useMemo, useRef, useState } from "react"
import { bundledLanguages } from "shiki"
import type { BundledLanguage } from "shiki"
import type { ExtraProps } from "streamdown"
import { defaultRemarkPlugins, Streamdown } from "streamdown"

export function ChatMessage({
  from,
  avatar,
  footer,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant"
  avatar?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div
      className={cn(
        "group flex w-full min-w-0 flex-col",
        from === "user" && "items-end gap-1",
        className
      )}
      {...props}
    >
      {from === "user" ? (
        <div className="flex w-full items-end justify-end gap-2">
          <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-sm text-message-foreground">
            {children}
          </div>
          {avatar}
        </div>
      ) : (
        <div className="relative min-w-0 px-1 py-0.5 text-sm">{children}</div>
      )}
      {footer}
    </div>
  )
}

type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  agentName?: string
  workspaceId?: string
  onAgentFileOpen?: (path: string, name: string) => void
  plainCodeBlocks?: boolean
}

const streamdownPlugins = { cjk, code, math, mermaid }
const codeLanguagePattern = /language-([^\s]+)/

function isBundledLanguage(language: string): language is BundledLanguage {
  return language in bundledLanguages
}

function codeBlockLanguage(language: string): BundledLanguage {
  const codeLanguage = language.toLowerCase()
  if (isBundledLanguage(codeLanguage)) {
    return codeLanguage
  }

  return "markdown"
}

type MarkdownCodeProps = ComponentProps<"code"> &
  ExtraProps & {
    "data-block"?: string
  }

type MarkdownCodeElementProps = MarkdownCodeProps & {
  plainCodeBlocks?: boolean
}

const MarkdownCode = ({
  children,
  className,
  plainCodeBlocks = false,
  ...props
}: MarkdownCodeProps & { plainCodeBlocks?: boolean }) => {
  const blockCode = typeof children === "string" ? children : Children.toArray(children).join("")
  const trimmedBlockCode = blockCode.replace(/\n+$/u, "")

  if (props["data-block"]) {
    if (plainCodeBlocks) {
      return (
        <code
          className={cn("block font-mono text-sm wrap-break-word whitespace-pre-wrap", className)}
          {...props}
        >
          {trimmedBlockCode}
        </code>
      )
    }

    const language = className?.match(codeLanguagePattern)?.[1] ?? "text"

    return (
      <CodeBlock
        className="my-2 w-full"
        code={trimmedBlockCode}
        language={codeBlockLanguage(language)}
      />
    )
  }

  return (
    <code
      className={cn(
        "rounded-md border border-border bg-muted px-[0.35rem] py-[0.1rem] font-mono text-sm text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </code>
  )
}

const MarkdownPre: FC<ComponentProps<"pre"> & ExtraProps & { plainCodeBlocks?: boolean }> = ({
  children,
  className,
  plainCodeBlocks = false,
  ...props
}) => {
  if (!isValidElement<MarkdownCodeElementProps>(children)) {
    return <>{children}</>
  }

  if (plainCodeBlocks) {
    return (
      <pre
        className={cn("my-2 overflow-auto wrap-break-word whitespace-pre-wrap", className)}
        {...props}
      >
        {cloneElement(children, {
          plainCodeBlocks,
          "data-block": "true",
        })}
      </pre>
    )
  }

  return cloneElement(children, {
    plainCodeBlocks,
    "data-block": "true",
  })
}

const MarkdownUl: FC<ComponentProps<"ul"> & ExtraProps> = ({ children, className, ...props }) => (
  <ul className={cn("list-outside list-disc space-y-1 pl-5", className)} {...props}>
    {children}
  </ul>
)

const MarkdownOl: FC<ComponentProps<"ol"> & ExtraProps> = ({ children, className, ...props }) => (
  <ol className={cn("list-outside list-decimal space-y-1 pl-5", className)} {...props}>
    {children}
  </ol>
)

const MarkdownLi: FC<ComponentProps<"li"> & ExtraProps> = ({ children, className, ...props }) => (
  <li className={className} {...props}>
    {children}
  </li>
)

const MarkdownParagraph: FC<ComponentProps<"p"> & ExtraProps> = ({
  children,
  className,
  ...props
}) => (
  <p className={cn("leading-relaxed wrap-break-word whitespace-pre-line", className)} {...props}>
    {children}
  </p>
)

const agentFilePrefix = "/home/agentz/"
const inlineImageLimit = 8 * 1024 * 1024
const inlineVideoLimit = 32 * 1024 * 1024
const inlineVideoTypes = new Set(["video/mp4", "video/webm"])
const inlineImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
])

function linkAgentImages() {
  return (tree: Root) => {
    function rewrite(parent: Parents) {
      for (const [index, node] of parent.children.entries()) {
        if (
          node.type === "image" &&
          node.url.startsWith(agentFilePrefix) &&
          inlineImageTypes.has(inferAttachmentMediaType(node.url))
        ) {
          parent.children[index] = {
            type: "link",
            url: node.url,
            children: [{ type: "text", value: node.alt || "Open image" }],
          }
          continue
        }
        if ("children" in node) rewrite(node)
      }
    }
    rewrite(tree)
  }
}

const agentImageRemarkPlugins = [...Object.values(defaultRemarkPlugins), linkAgentImages]

function AgentMedia({
  agentName,
  alt,
  className,
  video,
  onOpen,
  path,
  workspaceId,
}: {
  agentName: string
  alt: string
  className?: string
  video: boolean
  onOpen: () => void
  path: string
  workspaceId: string
}) {
  const frame = useRef<HTMLSpanElement>(null)
  const nearViewport = useInView(frame, { margin: "200px", once: true })
  const [requested, setRequested] = useState(false)
  const [decoded, setDecoded] = useState<{ url: string; ok: boolean }>()
  const enabled = video ? requested : nearViewport
  const limit = video ? inlineVideoLimit : inlineImageLimit
  const types = video ? inlineVideoTypes : inlineImageTypes
  const { data, isPending } = useQuery({
    ...readAgentFileRawOptions({
      // One extra byte distinguishes oversized files from complete previews.
      headers: { "X-AgentZ-Workspace-ID": workspaceId, Range: `bytes=0-${limit}` },
      parseAs: "blob",
      path: { agentName },
      query: { path },
    }),
    enabled,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    select: (blob) => (blob.size <= limit && types.has(blob.type) ? blob : undefined),
  })
  const url = useObjectURL(data)
  const ready = url !== undefined && decoded?.url === url && decoded.ok
  const failed = (!isPending && !data) || (decoded?.ok === false && decoded.url === url)
  const loading = enabled && !ready && !failed
  return (
    <span
      className={cn(
        "my-2 block w-full min-w-0 overflow-hidden rounded-lg",
        video && "border border-border",
        className
      )}
    >
      {video ? (
        <span className="flex h-10 items-center gap-2 bg-card px-3 text-sm">
          <Film aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium" title={alt}>
            {alt}
          </span>
          <button
            aria-label={`Open ${alt} in Files`}
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
            type="button"
          >
            <FolderOpen aria-hidden="true" className="size-3.5" />
            Open in Files
          </button>
        </span>
      ) : null}
      <span
        aria-busy={loading}
        className={cn(
          "relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden",
          video ? "bg-neutral-950 text-white [color-scheme:dark]" : "bg-muted/40 text-primary"
        )}
        ref={video ? undefined : frame}
      >
        {!video && !ready && !failed ? (
          <span
            aria-hidden="true"
            className={cn("absolute inset-0 bg-muted", enabled && "motion-safe:animate-pulse")}
          />
        ) : null}
        {url && !failed && video ? (
          <video
            aria-label={alt}
            className={cn(
              "absolute inset-0 size-full object-contain motion-safe:transition-opacity motion-safe:duration-150",
              !ready && "invisible opacity-0"
            )}
            controls
            onError={() => setDecoded({ url, ok: false })}
            onLoadedMetadata={() => setDecoded({ url, ok: true })}
            playsInline
            preload="metadata"
            src={url}
          />
        ) : null}
        {url && !failed && !video ? (
          // eslint-disable-next-line @next/next/no-img-element -- Next Image cannot serve object URLs.
          <img
            alt={alt}
            className={cn(
              "absolute inset-0 size-full object-contain motion-safe:transition-opacity motion-safe:duration-150",
              !ready && "opacity-0"
            )}
            decoding="async"
            onError={() => setDecoded({ url, ok: false })}
            onLoad={() => setDecoded({ url, ok: true })}
            src={url}
          />
        ) : null}
        {video && !requested && !failed ? (
          <button
            aria-label={`Load ${alt}`}
            className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-full bg-white px-4 text-sm font-medium text-neutral-950 hover:bg-neutral-200 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-neutral-950"
            onClick={() => setRequested(true)}
            type="button"
          >
            <Play aria-hidden="true" className="size-4 fill-current" />
            Load video
          </button>
        ) : null}
        {video && loading ? (
          <span role="status" className="flex items-center gap-2 text-sm text-neutral-300">
            <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            Loading video…
          </span>
        ) : null}
        {video && failed ? (
          <span role="status" className="px-4 text-center text-sm text-neutral-300">
            Inline playback unavailable.
          </span>
        ) : null}
        {!video ? (
          <button
            aria-label={`Open ${alt} in Files`}
            className="absolute inset-0 grid cursor-pointer place-items-center px-4 underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={onOpen}
            type="button"
          >
            {failed ? `Open ${alt} in Files` : null}
          </button>
        ) : null}
      </span>
    </span>
  )
}

const MarkdownLink = ({
  agentName,
  children,
  className,
  href,
  onAgentFileOpen,
  workspaceId,
  ...props
}: ComponentProps<"a"> &
  ExtraProps &
  Pick<MessageResponseProps, "agentName" | "workspaceId" | "onAgentFileOpen">) => {
  let path = ""
  if (onAgentFileOpen && href?.startsWith(agentFilePrefix)) {
    path = href.slice(agentFilePrefix.length)
    try {
      path = decodeURIComponent(path)
    } catch {
      // Keep malformed URLs clickable so Files can report the error.
    }
  }

  const name = path.slice(path.lastIndexOf("/") + 1)
  if (!name || !onAgentFileOpen) {
    return (
      <a
        className={cn("wrap-anywhere text-primary underline underline-offset-4", className)}
        href={href}
        {...props}
      >
        {children}
      </a>
    )
  }

  const mediaType = inferAttachmentMediaType(name)
  const video = inlineVideoTypes.has(mediaType)
  if (agentName && workspaceId && (video || inlineImageTypes.has(mediaType))) {
    return (
      <AgentMedia
        agentName={agentName}
        alt={typeof children === "string" ? children : name}
        className={className}
        onOpen={() => onAgentFileOpen(path, name)}
        path={path}
        video={video}
        workspaceId={workspaceId}
      />
    )
  }

  return (
    <button
      aria-label={`Preview ${name}`}
      className={cn(
        "my-2 block w-full max-w-full cursor-pointer touch-manipulation rounded-xl text-left no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
        className
      )}
      onClick={() => onAgentFileOpen(path, name)}
      type="button"
    >
      <Attachments className="w-full gap-0" variant="wide">
        <Attachment
          data={{
            filename: name,
            id: path,
            mediaType,
            path,
            type: "file",
          }}
        >
          <AttachmentPreview />
        </Attachment>
      </Attachments>
    </button>
  )
}

export const MessageResponse = memo(
  ({
    agentName,
    className,
    onAgentFileOpen,
    plainCodeBlocks = false,
    workspaceId,
    ...props
  }: MessageResponseProps) => {
    // Stable renderer identities let Streamdown reuse completed Markdown blocks.
    const components = useMemo<ComponentProps<typeof Streamdown>["components"]>(
      () => ({
        a: (linkProps) => (
          <MarkdownLink
            {...linkProps}
            agentName={agentName}
            workspaceId={workspaceId}
            onAgentFileOpen={onAgentFileOpen}
          />
        ),
        code: (codeProps) => <MarkdownCode {...codeProps} plainCodeBlocks={plainCodeBlocks} />,
        li: MarkdownLi,
        ol: MarkdownOl,
        p: MarkdownParagraph,
        pre: (preProps) => <MarkdownPre {...preProps} plainCodeBlocks={plainCodeBlocks} />,
        ul: MarkdownUl,
      }),
      [agentName, onAgentFileOpen, plainCodeBlocks, workspaceId]
    )
    return (
      <Streamdown
        className={cn(
          "w-full min-w-0 space-y-[0.65rem] text-base leading-relaxed wrap-break-word text-foreground/80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        components={components}
        plugins={streamdownPlugins}
        remarkPlugins={
          agentName && workspaceId && onAgentFileOpen ? agentImageRemarkPlugins : undefined
        }
        {...props}
      />
    )
  }
)

MessageResponse.displayName = "MessageResponse"
