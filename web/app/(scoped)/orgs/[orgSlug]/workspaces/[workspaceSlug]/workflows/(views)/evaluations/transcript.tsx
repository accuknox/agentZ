"use client"

import { useState } from "react"
import { Brain, CircleAlert, User, Wrench } from "lucide-react"
import type {
  EvaluationEvidenceReference,
  EvaluationTranscriptSession,
  Part,
} from "@/lib/gateway/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TablePagination } from "@/components/table-pagination"
import {
  TraceInspectorLayout,
  TraceInspectorRow,
  TraceInspectorDetail,
  TraceTokenMeter,
  TraceContentPanel,
} from "@/components/trace-inspector"
import { formatDurationMs, formatRecentTimestamp } from "@/lib/format"

type TranscriptStep = {
  id: string
  message: EvaluationTranscriptSession["messages"][number]
  tool?: Extract<Part, { type: "tool" }>
  label: string
  start: number
  end: number
  tokens: number
}

export function Transcript({
  sessions,
  reference,
}: {
  sessions: EvaluationTranscriptSession[]
  reference?: EvaluationEvidenceReference
}) {
  const [selection, setSelection] = useState(() => ({
    sessionId: reference?.session_id ?? sessions[0]?.session_id,
    stepId: reference?.part_id ?? reference?.message_id,
  }))
  const session = sessions.find((item) => item.session_id === selection.sessionId) ?? sessions[0]
  if (!session) return <p className="p-6 text-sm text-muted-foreground">No transcript available.</p>

  const steps = session.messages.flatMap<TranscriptStep>((message) => {
    const assistant = message.info.role === "assistant" ? message.info : undefined
    const start = message.info.time.created
    const end = assistant?.time.completed ?? start
    return [
      {
        id: message.info.id,
        message,
        label: assistant ? "Model call" : "Input",
        start,
        end,
        tokens: assistant
          ? assistant.tokens.input +
            assistant.tokens.output +
            assistant.tokens.reasoning +
            assistant.tokens.cache.read +
            assistant.tokens.cache.write
          : 0,
      },
      ...message.parts
        .filter((part) => part.type === "tool")
        .map((tool) => ({
          id: tool.id,
          message,
          tool,
          label: tool.tool,
          tokens: 0,
          start: tool.state.status === "pending" ? start : tool.state.time.start,
          end:
            tool.state.status === "completed" || tool.state.status === "error"
              ? tool.state.time.end
              : end,
        })),
    ]
  })
  const selected =
    steps.find((step) => step.id === selection.stepId) ??
    steps.find((step) => step.message.parts.some((part) => part.id === selection.stepId)) ??
    steps.find((step) => step.message.info.role === "assistant") ??
    steps[0]
  const index = selected ? steps.indexOf(selected) : 0
  const page = Math.floor(index / 25)
  const start = steps.reduce(
    (start, step) => Math.min(start, step.start),
    session.session.time.created
  )
  const end = steps.reduce((end, step) => Math.max(end, step.end), start)
  const duration = Math.max(end - start, 1)
  const info = selected?.message.info
  const toolCalls = selected?.message.parts.filter((part) => part.type === "tool") ?? []
  const missingReference =
    reference &&
    !sessions.some(
      (item) =>
        item.session_id === reference.session_id &&
        item.messages.some(
          (message) =>
            message.info.id === reference.message_id &&
            (!reference.part_id || message.parts.some((part) => part.id === reference.part_id))
        )
    )

  return (
    <TraceInspectorLayout
      title={
        sessions.length > 1 ? (
          <Select
            value={session.session_id}
            onValueChange={(sessionId) => setSelection({ sessionId, stepId: undefined })}
          >
            <SelectTrigger
              aria-label="Transcript session"
              size="sm"
              className="max-w-48 border-0 bg-transparent shadow-none"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sessions.map((item, index) => (
                  <SelectItem key={item.session_id} value={item.session_id}>
                    {index === 0 ? "Execution" : `Session ${index + 1}`}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          "Execution"
        )
      }
      pagination={
        <TablePagination
          canGoPrevious={page > 0}
          canGoNext={(page + 1) * 25 < steps.length}
          goPrevious={() => setSelection({ ...selection, stepId: steps[(page - 1) * 25]?.id })}
          goNext={() => setSelection({ ...selection, stepId: steps[(page + 1) * 25]?.id })}
        />
      }
      navigation={
        steps.length ? (
          steps
            .slice(page * 25, (page + 1) * 25)
            .map((step) => (
              <TraceInspectorRow
                key={step.id}
                id={step.id}
                label={step.label}
                icon={
                  step.tool ? (
                    <Wrench />
                  ) : step.message.info.role === "assistant" ? (
                    <Brain />
                  ) : (
                    <User />
                  )
                }
                selected={selected?.id === step.id}
                onClick={() => setSelection({ ...selection, stepId: step.id })}
                depth={0}
                duration={formatDurationMs(Math.max(step.end - step.start, 0))}
                tokens={step.tokens}
                hasError={
                  step.tool
                    ? step.tool.state.status === "error"
                    : step.message.info.role === "assistant" && !!step.message.info.error
                }
                timelineClass={step.tool ? "bg-chart-4" : "bg-chart-1"}
                durationPercent={(Math.max(step.end - step.start, 0) / duration) * 100}
                offsetPercent={((step.start - start) / duration) * 100}
              />
            ))
        ) : (
          <p className="px-5 py-10 text-sm text-muted-foreground">No messages recorded.</p>
        )
      }
    >
      <TraceInspectorDetail
        title={selected?.label ?? "Execution"}
        started={
          selected ? formatRecentTimestamp(new Date(selected.start).toISOString()) : undefined
        }
        duration={
          selected ? formatDurationMs(Math.max(selected.end - selected.start, 0)) : undefined
        }
        tokens={selected?.tokens}
      >
        {missingReference ? (
          <Alert variant="destructive" className="mb-5">
            <CircleAlert />
            <AlertDescription>The cited step is not in the retained transcript.</AlertDescription>
          </Alert>
        ) : null}
        {info?.role === "assistant" && !selected?.tool ? (
          <TraceTokenMeter
            segments={[
              { label: "Input", value: info.tokens.input, colorClass: "bg-chart-1" },
              { label: "Cache read", value: info.tokens.cache.read, colorClass: "bg-chart-3" },
              { label: "Cache write", value: info.tokens.cache.write, colorClass: "bg-chart-2" },
              { label: "Output", value: info.tokens.output, colorClass: "bg-chart-4" },
              { label: "Reasoning", value: info.tokens.reasoning, colorClass: "bg-chart-5" },
            ]}
          />
        ) : null}
        <div className="flex flex-col gap-5">
          {info?.role === "assistant" && info.error ? (
            <TraceContentPanel
              title="Error"
              text={
                info.error.name === "MessageOutputLengthError"
                  ? "The model reached its output limit."
                  : info.error.data.message
              }
            />
          ) : null}
          {selected
            ? (selected.tool
                ? [selected.tool]
                : selected.message.parts.filter((part) => part.type !== "tool")
              ).map((part) => (
                <TranscriptPart key={part.id} part={part} role={selected.message.info.role} />
              ))
            : null}
          {!selected?.tool && toolCalls.length > 0 ? (
            <TraceContentPanel
              title="Tool calls"
              code={JSON.stringify(
                toolCalls.map((tool) => ({
                  id: tool.callID,
                  name: tool.tool,
                  arguments: tool.state.input,
                })),
                null,
                2
              )}
            />
          ) : null}
          {selected ? (
            <TraceContentPanel
              title="Usage"
              code={JSON.stringify(
                {
                  "session.id": session.session_id,
                  "message.id": selected.message.info.id,
                  "part.id": selected.tool?.id,
                  "call.id": selected.tool?.callID,
                  status: selected.tool?.state.status,
                  model: !selected.tool && info?.role === "assistant" ? info.modelID : undefined,
                  provider:
                    !selected.tool && info?.role === "assistant" ? info.providerID : undefined,
                  finish: !selected.tool && info?.role === "assistant" ? info.finish : undefined,
                  tokens: !selected.tool && info?.role === "assistant" ? info.tokens : undefined,
                },
                null,
                2
              )}
            />
          ) : null}
        </div>
      </TraceInspectorDetail>
    </TraceInspectorLayout>
  )
}

function TranscriptPart({ part, role }: { part: Part; role: "user" | "assistant" }) {
  switch (part.type) {
    case "text":
      return <TraceContentPanel title={role === "user" ? "Input" : "Output"} text={part.text} />
    case "reasoning":
      return <TraceContentPanel title="Reasoning" text={part.text} />
    case "tool":
      return (
        <>
          <TraceContentPanel
            title="Tool arguments"
            code={JSON.stringify(part.state.input, null, 2)}
          />
          {part.state.status === "completed" ? (
            <>
              <TraceContentPanel title="Tool result" text={part.state.output} />
              {part.state.attachments?.length ? (
                <TraceContentPanel
                  title="Attachments"
                  code={JSON.stringify(
                    part.state.attachments.map((file) => ({
                      filename: file.filename,
                      mime: file.mime,
                    })),
                    null,
                    2
                  )}
                />
              ) : null}
            </>
          ) : part.state.status === "error" ? (
            <TraceContentPanel title="Error" text={part.state.error} />
          ) : (
            <p className="text-sm text-muted-foreground">Tool {part.state.status} when recorded.</p>
          )}
        </>
      )
    case "file":
      return <TraceContentPanel title="Attachment" text={part.filename ?? part.mime} />
    case "subtask":
      return <TraceContentPanel title={part.description} text={part.prompt} />
    case "agent":
      return <TraceContentPanel title="Agent" text={part.name} />
    case "patch":
      return <TraceContentPanel title="Changed files" code={JSON.stringify(part.files, null, 2)} />
    case "retry":
      return <TraceContentPanel title={`Retry ${part.attempt}`} text={part.error.data.message} />
    case "compaction":
      return <p className="text-xs text-muted-foreground">Context compacted</p>
    case "step-start":
    case "step-finish":
      return null
    case "snapshot":
      return <TraceContentPanel title="Snapshot" text={part.snapshot} />
  }
}
