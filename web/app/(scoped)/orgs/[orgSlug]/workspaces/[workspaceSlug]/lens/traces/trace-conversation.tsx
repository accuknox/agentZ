"use client"

import { useEffect, useRef, useState } from "react"
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query"
import { ArrowUpRight, Bot, ChevronDown, ChevronRight, MessageSquare, Wrench } from "lucide-react"
import { getTraceRecordingAction } from "@/data/lens.actions"
import type { TraceListItem } from "@/data/types"
import type { AppSpan, Span } from "@/lib/gateway/client"
import { dayjs, formatDurationMs } from "@/lib/format"
import { ChatMessage, MessageResponse } from "@/components/ai-elements/message"
import { ToolCard, ToolCode } from "@/components/blocks/chat/tool-parts"
import { CopyButton } from "@/components/interior/copy-button"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { TablePagination } from "@/components/table-pagination"
import {
  TraceInspectorDetail,
  TraceInspectorLayout,
  TraceInspectorRow,
  TraceInspectorSkeleton,
} from "@/components/trace-inspector"

export function TraceConversation({
  trace,
  workspaceId,
  onInspect,
}: {
  trace: TraceListItem
  workspaceId: string
  onInspect: (span: AppSpan | Span) => void
}) {
  const transcript = useRef<HTMLDivElement>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string>()
  const promptLabel = trace.subject.kind === "app" ? "Request" : "User"
  const recording = useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: ["trace-recording", workspaceId, trace.subject, trace.traceId],
      initialPageParam: "",
      queryFn: async ({ pageParam }) => {
        const result = await getTraceRecordingAction(
          trace.subject,
          trace.traceId,
          workspaceId,
          pageParam || undefined
        )
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      getNextPageParam: (page) => page.nextPageToken || undefined,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: false,
    })
  )
  const pages = recording.data?.pages ?? []
  const steps = pages.flatMap((page) => page.steps)
  const pageKeys = new Set(pages[pageIndex]?.steps.map((step) => step.key))
  const items = steps
    .filter((step) => step.kind !== "response" || step.text || step.span.status_code === "ERROR")
    .map((step) => {
      let label = "Assistant"
      if (step.kind === "prompt") label = promptLabel
      if (step.kind === "tool") label = step.span.tool_name || step.span.name
      const durationMs = step.kind === "prompt" ? null : step.span.duration_ms
      const tokens =
        step.kind === "response" &&
        step.span.input_tokens !== null &&
        step.span.output_tokens !== null
          ? step.span.input_tokens + step.span.output_tokens
          : undefined
      const offsetMs = Math.max(
        dayjs(step.span.start_time).valueOf() - dayjs(trace.startedAt).valueOf(),
        0
      )
      return {
        step,
        label,
        tokens,
        duration: durationMs === null ? undefined : formatDurationMs(durationMs),
        durationPercent:
          trace.durationMs > 0 && durationMs !== null
            ? Math.min((durationMs / trace.durationMs) * 100, 100)
            : 0,
        offsetPercent:
          trace.durationMs > 0 ? Math.min((offsetMs / trace.durationMs) * 100, 100) : 0,
      }
    })
  const navigation = items.filter((item) => pageKeys.has(item.step.key))
  const selected = navigation.find((item) => item.step.key === selectedKey) ?? navigation[0]
  const currentKey = selected?.step.key

  useEffect(() => {
    if (!currentKey) return
    transcript.current
      ?.querySelector(`[data-message="${currentKey}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [currentKey])

  if (recording.isPending) return <TraceInspectorSkeleton />

  return (
    <TraceInspectorLayout
      title="Conversation"
      pagination={
        <TablePagination
          canGoPrevious={pageIndex > 0}
          canGoNext={pageIndex < pages.length - 1 || recording.hasNextPage}
          pending={recording.isFetchingNextPage}
          goPrevious={() => {
            setPageIndex(pageIndex - 1)
            setSelectedKey(undefined)
          }}
          goNext={async () => {
            if (pageIndex === pages.length - 1) {
              const result = await recording.fetchNextPage()
              if (result.isError) return
            }
            setPageIndex(pageIndex + 1)
            setSelectedKey(undefined)
          }}
        />
      }
      navigation={
        navigation.length ? (
          navigation.map((item) => (
            <TraceInspectorRow
              key={item.step.key}
              label={item.label}
              icon={
                item.step.kind === "prompt" ? (
                  <MessageSquare />
                ) : item.step.kind === "tool" ? (
                  <Wrench />
                ) : (
                  <Bot />
                )
              }
              selected={selected?.step.key === item.step.key}
              onClick={() => setSelectedKey(item.step.key)}
              depth={0}
              duration={item.duration}
              tokens={item.tokens}
              id={item.step.span.span_id}
              hasError={item.step.kind !== "prompt" && item.step.span.status_code === "ERROR"}
              timelineClass={item.step.kind === "tool" ? "bg-chart-4" : "bg-chart-1"}
              durationPercent={item.durationPercent}
              offsetPercent={item.offsetPercent}
            />
          ))
        ) : (
          <p className="px-4 py-10 text-sm text-muted-foreground lg:px-5">No messages</p>
        )
      }
    >
      <TraceInspectorDetail
        title="Conversation"
        started={trace.startedDate}
        duration={trace.duration}
        tokens={trace.totalTokens ?? undefined}
      >
        {recording.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {recording.error.message}
              <Button variant="link" size="sm" onClick={() => recording.refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div ref={transcript} className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-1">
          {items.map(({ step, label, duration, tokens }) => {
            const messageClass = cn(
              "scroll-mt-4 rounded-md border-2 border-dashed border-transparent",
              step.key === currentKey && "border-primary"
            )
            const inspect = (
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={`View ${label.toLowerCase()} span`}
                title="View span"
                onClick={() => onInspect(step.span)}
              >
                <ArrowUpRight />
              </Button>
            )
            if (step.kind === "tool") {
              return (
                <div
                  key={step.key}
                  data-message={step.key}
                  className={cn(messageClass, "px-1 py-0.5")}
                >
                  <ToolCard
                    title={
                      <span className="inline-flex items-center gap-2">
                        <Wrench className="size-3.5 text-muted-foreground" />
                        {label}
                      </span>
                    }
                    arg={step.arguments.text.slice(0, 300)}
                    tone={step.span.status_code === "ERROR" ? "error" : "neutral"}
                    action={inspect}
                  >
                    <div className="my-2 flex min-w-0 flex-col gap-3">
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs text-muted-foreground">Input</span>
                        <RecordedText {...step.arguments} />
                      </div>
                      {step.result ? (
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <span className="text-xs text-muted-foreground">Output</span>
                          <RecordedText {...step.result} />
                        </div>
                      ) : !step.error && !step.span.error_message ? (
                        <p className="text-xs text-muted-foreground">No output captured.</p>
                      ) : null}
                      {step.error ? (
                        <div role="alert" className="text-destructive">
                          <RecordedText {...step.error} />
                        </div>
                      ) : step.span.error_message ? (
                        <p role="alert" className="text-sm text-destructive">
                          {step.span.error_message}
                        </p>
                      ) : null}
                    </div>
                  </ToolCard>
                </div>
              )
            }
            return (
              <ChatMessage
                key={step.key}
                from={step.kind === "prompt" ? "user" : "assistant"}
                data-message={step.key}
                className={cn(messageClass, "py-3")}
                footer={
                  <div
                    className={cn(
                      "mt-1 flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100",
                      step.kind === "prompt" && "justify-end"
                    )}
                  >
                    {step.kind === "response" ? (
                      <>
                        {step.span.model ? <span>{step.span.model}</span> : null}
                        {duration ? <span>{duration}</span> : null}
                        {tokens !== undefined ? (
                          <span>{tokens.toLocaleString()} tokens</span>
                        ) : null}
                      </>
                    ) : null}
                    {step.text ? <CopyButton content={step.text} label="Copy message" /> : null}
                    {inspect}
                  </div>
                }
              >
                {step.text ? <RecordedText text={step.text} format="markdown" /> : null}
                {step.kind === "response" && step.span.status_code === "ERROR" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {step.span.error_message || step.span.error_type || "The model request failed."}
                  </p>
                ) : null}
                {step.kind === "prompt" && step.context.length ? (
                  <Collapsible className="group/context mt-2">
                    <CollapsibleTrigger className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <ChevronRight className="size-3 group-data-[state=open]/context:rotate-90" />
                      Client context
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 flex flex-col gap-3">
                        {step.context.map((text, index) => (
                          <RecordedText key={index} text={text} format="text" />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </ChatMessage>
            )
          })}
          {!items.length && !recording.error ? (
            <p className="text-sm text-muted-foreground">
              No conversation content was captured. Details are available in Spans.
            </p>
          ) : null}
        </div>
      </TraceInspectorDetail>
    </TraceInspectorLayout>
  )
}

function RecordedText({ text, format }: { text: string; format: "markdown" | "json" | "text" }) {
  const [expanded, setExpanded] = useState(false)
  const clipped = !expanded && text.length > 6000
  const content = clipped ? text.slice(0, 6000) : text
  return (
    <div className="min-w-0 text-sm wrap-break-word">
      {format === "json" ? (
        <ToolCode code={content} language="json" />
      ) : format === "markdown" ? (
        <MessageResponse mode="static">{content}</MessageResponse>
      ) : (
        <pre className="max-h-64 overflow-auto font-mono text-xs leading-5 wrap-break-word whitespace-pre-wrap">
          {content}
        </pre>
      )}
      {clipped ? (
        <Button
          variant="link"
          size="sm"
          className="mt-2 px-0 text-xs text-muted-foreground"
          onClick={() => setExpanded(true)}
        >
          Read more <ChevronDown data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  )
}
