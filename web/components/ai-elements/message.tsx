"use client"

import {
  Attachment,
  AttachmentPreview,
  Attachments,
  inferAttachmentMediaType,
} from "@/components/ai-elements/attachments"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { cn } from "@/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import type { ComponentProps, HTMLAttributes, FC, ReactNode } from "react"
import { Children, cloneElement, isValidElement, memo, useMemo } from "react"
import { bundledLanguages } from "shiki"
import type { BundledLanguage } from "shiki"
import type { ExtraProps } from "streamdown"
import { Streamdown } from "streamdown"

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

const MarkdownLink = ({
  children,
  className,
  href,
  onAgentFileOpen,
  ...props
}: ComponentProps<"a"> & ExtraProps & Pick<MessageResponseProps, "onAgentFileOpen">) => {
  const agentFile = href?.startsWith(agentFilePrefix)
    ? href.slice(agentFilePrefix.length)
    : undefined
  if (!agentFile || !onAgentFileOpen) {
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

  let path = agentFile
  try {
    path = decodeURIComponent(agentFile)
  } catch {
    // Keep malformed URLs clickable; the workspace will surface a read error.
  }

  const name = path.slice(path.lastIndexOf("/") + 1)
  if (!name) {
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
            mediaType: inferAttachmentMediaType(name),
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
  ({ className, onAgentFileOpen, plainCodeBlocks = false, ...props }: MessageResponseProps) => {
    // Stable renderer identities let Streamdown reuse completed Markdown blocks.
    const components = useMemo<ComponentProps<typeof Streamdown>["components"]>(
      () => ({
        a: (linkProps) => <MarkdownLink {...linkProps} onAgentFileOpen={onAgentFileOpen} />,
        code: (codeProps) => <MarkdownCode {...codeProps} plainCodeBlocks={plainCodeBlocks} />,
        li: MarkdownLi,
        ol: MarkdownOl,
        p: MarkdownParagraph,
        pre: (preProps) => <MarkdownPre {...preProps} plainCodeBlocks={plainCodeBlocks} />,
        ul: MarkdownUl,
      }),
      [onAgentFileOpen, plainCodeBlocks]
    )
    return (
      <Streamdown
        className={cn(
          "w-full min-w-0 space-y-[0.65rem] text-base leading-relaxed wrap-break-word text-foreground/80 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        components={components}
        plugins={streamdownPlugins}
        {...props}
      />
    )
  }
)

MessageResponse.displayName = "MessageResponse"
