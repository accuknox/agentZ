"use client"

import { cn } from "@/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import type { UIMessage } from "ai"
import type { ComponentProps, HTMLAttributes } from "react"
import { memo } from "react"
import { Streamdown, type Components } from "streamdown"

import { CodeBlock } from "./code-block"

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"]
  tone?: "active" | "error" | "interrupted" | "neutral" | "user"
}

export const Message = ({ className, from, tone, ...props }: MessageProps) => (
  <div
    data-tone={tone ?? from}
    className={cn(
      "group flex w-full flex-col gap-2 border-l-2 py-3 pr-2 pl-2.5 font-mono",
      "border-transparent data-[tone=active]:border-chat-active",
      "data-[tone=error]:border-chat-error data-[tone=interrupted]:border-chat-interrupted",
      "data-[tone=user]:border-chat-user",
      from === "user" ? "is-user bg-muted/35" : "is-assistant",
      className
    )}
    {...props}
  />
)

export type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-[0.95rem] leading-7",
      "text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
)

export type MessageResponseProps = ComponentProps<typeof Streamdown>

const streamdownPlugins = { cjk, code, math, mermaid }
const codeLanguagePattern = /language-(\S+)/
const streamdownComponents: Components = {
  code: ({ children, className, ...props }) => {
    if (!("data-block" in props)) {
      return (
        <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}>
          {children}
        </code>
      )
    }

    const code = (typeof children === "string" ? children : String(children ?? "")).replace(
      /\n+$/,
      ""
    )
    const language = (className?.match(codeLanguagePattern)?.[1] ?? "text") as ComponentProps<
      typeof CodeBlock
    >["language"]

    return <CodeBlock code={code} language={language} showLineNumbers={false} />
  },
}

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full whitespace-pre-wrap break-words",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_blockquote]:my-[0.0875rem] [&_blockquote]:py-0 [&_blockquote]:pr-3 [&_blockquote]:pl-4",
        "[&_blockquote_p]:my-0 [&_p]:my-[0.0875rem] [&_pre]:my-[0.0875rem]",
        "[&_ol]:my-[0.0875rem] [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_ul]:my-[0.0875rem] [&_ul]:list-disc [&_ul]:pl-6",
        "[&_li]:my-0 [&_li]:pl-1",
        className
      )}
      components={streamdownComponents}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating
)

MessageResponse.displayName = "MessageResponse"
