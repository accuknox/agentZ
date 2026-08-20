"use client"

import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"
import { BrainIcon, ChevronDownIcon } from "lucide-react"
import type { Dayjs } from "dayjs"
import type { ComponentProps, ReactNode } from "react"
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from "react"
import { Streamdown } from "streamdown"
import { dayjs } from "@/lib/format"

import { Shimmer } from "./shimmer"

interface ReasoningContextValue {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

const useReasoning = () => {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning")
  }
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
}

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    })
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    })

    const startTimeRef = useRef<Dayjs | null>(null)
    const userClosedRef = useRef(false)
    const wasStreamingRef = useRef(isStreaming)

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = dayjs()
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil(dayjs().diff(startTimeRef.current, "second", true)))
        startTimeRef.current = null
      }
    }, [isStreaming, setDuration])

    useEffect(() => {
      if (isStreaming && !wasStreamingRef.current) {
        userClosedRef.current = false
      }
      wasStreamingRef.current = isStreaming
    }, [isStreaming])

    // Auto-open when streaming starts unless the user closed this block.
    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed && !userClosedRef.current) {
        setIsOpen(true)
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed])

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        userClosedRef.current = isStreaming && !newOpen
        setIsOpen(newOpen)
      },
      [isStreaming, setIsOpen]
    )

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen]
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  }
)

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <Shimmer duration={1}>Thinking…</Shimmer>
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>
  }
  return <p>Thought for {duration} seconds</p>
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning()

    return (
      <CollapsibleTrigger
        className={cn(
          "text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
            />
          </>
        )}
      </CollapsibleTrigger>
    )
  }
)

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string
}

const streamdownPlugins = { cjk, code, math, mermaid }

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn(
      "border-muted-foreground/45 mt-1 ml-7 rounded-l-none border-l pt-0.5 pl-3 text-sm",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
      "[&_blockquote]:border-muted-foreground/35 [&_blockquote]:border-l [&_blockquote]:pl-4",
      "[&_ol]:ml-6 [&_ol]:list-outside [&_ol]:list-decimal [&_ol]:space-y-1",
      "[&_ul]:ml-6 [&_ul]:list-outside [&_ul]:list-disc [&_ul]:space-y-1",
      "[&_li]:pl-1",
      "data-[state=closed]:border-l-0 data-[state=closed]:pl-0",
      className
    )}
    {...props}
  >
    <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
  </CollapsibleContent>
))

Reasoning.displayName = "Reasoning"
ReasoningTrigger.displayName = "ReasoningTrigger"
ReasoningContent.displayName = "ReasoningContent"
