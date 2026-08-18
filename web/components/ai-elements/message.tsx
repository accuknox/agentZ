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
import type { UIMessage } from "ai"
import type { ComponentProps, HTMLAttributes, FC } from "react"
import { Children, cloneElement, isValidElement, memo } from "react"
import { bundledLanguages } from "shiki"
import type { BundledLanguage } from "shiki"
import type { ExtraProps } from "streamdown"
import { Streamdown } from "streamdown"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-full max-w-full min-w-0 flex-col text-sm",
      "group-[.is-user]:w-fit",
      "group-[.is-user]:border-primary group-[.is-user]:bg-secondary group-[.is-user]:text-foreground group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:rounded-r-none group-[.is-user]:border-r-2 group-[.is-user]:px-4 group-[.is-user]:py-3",
      "group-[.is-assistant]:text-foreground",
      "group-[.is-assistant]:gap-1",
      "group-[.is-system-message]:border-destructive group-[.is-system-message]:w-full group-[.is-system-message]:max-w-full group-[.is-system-message]:rounded-l-none group-[.is-system-message]:rounded-r-none group-[.is-system-message]:border-r-2 group-[.is-system-message]:border-l-2 group-[.is-system-message]:px-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
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
    <code className={cn("bg-muted rounded px-1.5 py-0.5 font-mono text-sm", className)} {...props}>
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
  <ul className={cn("ml-6 list-outside list-disc space-y-1", className)} {...props}>
    {children}
  </ul>
)

const MarkdownOl: FC<ComponentProps<"ol"> & ExtraProps> = ({ children, className, ...props }) => (
  <ol className={cn("ml-6 list-outside list-decimal space-y-1", className)} {...props}>
    {children}
  </ol>
)

const MarkdownLi: FC<ComponentProps<"li"> & ExtraProps> = ({ children, className, ...props }) => (
  <li className={cn("pl-1", className)} {...props}>
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
      <a className={cn("wrap-anywhere", className)} href={href} {...props}>
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
      <a className={cn("wrap-anywhere", className)} href={href} {...props}>
        {children}
      </a>
    )
  }

  return (
    <button
      aria-label={`Preview ${name}`}
      className={cn(
        "focus-visible:ring-ring my-2 block w-full max-w-full cursor-pointer touch-manipulation rounded-xl text-left no-underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
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
  ({ className, onAgentFileOpen, plainCodeBlocks = false, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "w-full min-w-0 wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      components={{
        a: (linkProps) => <MarkdownLink {...linkProps} onAgentFileOpen={onAgentFileOpen} />,
        code: (codeProps) => <MarkdownCode {...codeProps} plainCodeBlocks={plainCodeBlocks} />,
        li: MarkdownLi,
        ol: MarkdownOl,
        p: MarkdownParagraph,
        pre: (preProps) => <MarkdownPre {...preProps} plainCodeBlocks={plainCodeBlocks} />,
        ul: MarkdownUl,
      }}
      plugins={{
        ...streamdownPlugins,
      }}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating &&
    nextProps.onAgentFileOpen === prevProps.onAgentFileOpen &&
    nextProps.plainCodeBlocks === prevProps.plainCodeBlocks
)

MessageResponse.displayName = "MessageResponse"
