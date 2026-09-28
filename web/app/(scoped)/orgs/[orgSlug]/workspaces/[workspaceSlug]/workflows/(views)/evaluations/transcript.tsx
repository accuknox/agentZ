"use client"

import { useState } from "react"
import { Brain, ChevronDown, CircleAlert, FileText, GitBranch, User, Wrench } from "lucide-react"
import type {
  EvaluationEvidenceReference,
  EvaluationTranscriptSession,
  Part,
} from "@/lib/gateway/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TablePagination } from "@/components/table-pagination"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { MessageResponse } from "@/components/ai-elements/message"
import { formatCompactNumber, formatDurationSeconds } from "@/lib/format"
import { cn } from "@/lib/utils"

export function Transcript({
  sessions,
  reference,
}: {
  sessions: EvaluationTranscriptSession[]
  reference?: EvaluationEvidenceReference
}) {
  const [selection, setSelection] = useState(() => ({
    sessionId: reference?.session_id ?? sessions[0]?.session_id,
    messageId: reference?.message_id,
    partId: reference?.part_id,
  }))
  const session = sessions.find((item) => item.session_id === selection.sessionId) ?? sessions[0]
  if (!session)
    return <p className="text-muted-foreground py-6 text-sm">No transcript available.</p>
  const messageIndex = Math.max(
    0,
    session.messages.findIndex((item) => item.info.id === selection.messageId)
  )
  const message = session.messages[messageIndex]
  const part = message?.parts.find((item) => item.id === selection.partId)
  const page = Math.floor(messageIndex / 25)
  const info = message?.info
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
    <div className="flex min-h-0 flex-1 flex-col">
      {missingReference ? (
        <Alert variant="destructive" className="my-3">
          <CircleAlert />
          <AlertDescription>The cited step is not in the retained transcript.</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-center gap-3 py-3">
        <GitBranch className="text-muted-foreground size-4 shrink-0" />
        {sessions.length > 1 ? (
          <Select
            value={session.session_id}
            onValueChange={(sessionId) =>
              setSelection({ sessionId, messageId: undefined, partId: undefined })
            }
          >
            <SelectTrigger aria-label="Transcript session" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {sessions.map((item) => (
                  <SelectItem key={item.session_id} value={item.session_id}>
                    {item.session.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <span className="truncate text-sm">{session.session.title}</span>
        )}
        <span className="text-muted-foreground ml-auto shrink-0 text-xs">
          {session.messages.length} messages
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-md border lg:grid-cols-[34%_66%]">
        <aside className="min-h-0 border-b lg:border-r lg:border-b-0">
          <div className="bg-muted/10 flex h-10 items-center justify-between px-3">
            <span className="text-sm font-medium">Steps</span>
            <TablePagination
              canGoPrevious={page > 0}
              canGoNext={(page + 1) * 25 < session.messages.length}
              pending={false}
              goPrevious={() =>
                setSelection({
                  ...selection,
                  messageId: session.messages[(page - 1) * 25]?.info.id,
                  partId: undefined,
                })
              }
              goNext={() =>
                setSelection({
                  ...selection,
                  messageId: session.messages[(page + 1) * 25]?.info.id,
                  partId: undefined,
                })
              }
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-2 lg:h-full lg:max-h-[calc(100vh-19rem)]">
            {session.messages.slice(page * 25, (page + 1) * 25).map((item, index) => {
              const assistant = item.info.role === "assistant" ? item.info : undefined
              const active = item.info.id === info?.id
              const duration =
                assistant?.time.completed === undefined
                  ? undefined
                  : (assistant.time.completed - assistant.time.created) / 1000
              return (
                <div key={item.info.id}>
                  <button
                    type="button"
                    aria-pressed={active && !part}
                    className={cn(
                      "hover:bg-muted/35 flex w-full flex-col gap-1 border-l-4 border-transparent px-3 py-2 text-left",
                      active && !part && "border-primary/55 bg-muted/55"
                    )}
                    onClick={() =>
                      setSelection({ ...selection, messageId: item.info.id, partId: undefined })
                    }
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {assistant ? (
                        <Brain className="text-muted-foreground size-4 shrink-0" />
                      ) : (
                        <User className="text-muted-foreground size-4 shrink-0" />
                      )}
                      {assistant ? "Response" : "Input"}{" "}
                      <span className="text-muted-foreground ml-auto text-xs">
                        {page * 25 + index + 1}
                      </span>
                      {assistant?.error ? (
                        <CircleAlert className="text-destructive size-4" />
                      ) : null}
                    </span>
                    <span className="text-muted-foreground ml-6 flex flex-wrap gap-2 text-xs">
                      {duration !== undefined ? (
                        <span>{formatDurationSeconds(duration)}</span>
                      ) : null}
                      {assistant ? (
                        <span>
                          {formatCompactNumber(
                            assistant.tokens.input +
                              assistant.tokens.output +
                              assistant.tokens.reasoning +
                              assistant.tokens.cache.read +
                              assistant.tokens.cache.write
                          )}{" "}
                          tokens
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {item.parts
                    .filter((part) => part.type === "tool")
                    .map((tool) => (
                      <button
                        type="button"
                        key={tool.id}
                        aria-pressed={active && part?.id === tool.id}
                        className={cn(
                          "hover:bg-muted/35 flex w-full items-center gap-2 border-l-4 border-transparent py-2 pr-3 pl-8 text-left text-xs",
                          active && part?.id === tool.id && "border-primary/55 bg-muted/55"
                        )}
                        onClick={() =>
                          setSelection({ ...selection, messageId: item.info.id, partId: tool.id })
                        }
                      >
                        <Wrench className="text-muted-foreground size-3.5 shrink-0" />
                        <span className="truncate">{tool.tool}</span>
                        {tool.state.status === "error" ? (
                          <CircleAlert className="text-destructive ml-auto size-3.5" />
                        ) : null}
                      </button>
                    ))}
                </div>
              )
            })}
          </div>
        </aside>
        <section className="min-h-0 min-w-0">
          <div className="bg-muted/10 flex h-10 items-center gap-2 px-4 text-sm font-medium">
            {part?.type === "tool" ? (
              <Wrench className="size-4" />
            ) : (
              <FileText className="size-4" />
            )}
            {part?.type === "tool" ? part.tool : info?.role === "assistant" ? "Response" : "Input"}
          </div>
          <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto p-4 lg:max-h-[calc(100vh-19rem)]">
            {!message ? (
              <p className="text-muted-foreground text-sm">No messages recorded.</p>
            ) : (
              <>
                <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
                  <time dateTime={new Date(message.info.time.created).toISOString()}>
                    {new Date(message.info.time.created).toLocaleTimeString()}
                  </time>
                  {info?.role === "assistant" ? <span>{info.modelID}</span> : null}
                  {part?.type === "tool" ? (
                    <Badge variant={part.state.status === "error" ? "destructive" : "secondary"}>
                      {part.state.status}
                    </Badge>
                  ) : null}
                </div>
                {info?.role === "assistant" && !part ? (
                  <>
                    <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                      {[
                        { label: "Input", value: info.tokens.input },
                        { label: "Output", value: info.tokens.output },
                        { label: "Reasoning", value: info.tokens.reasoning },
                        { label: "Cache read", value: info.tokens.cache.read },
                        { label: "Cache write", value: info.tokens.cache.write },
                      ].map(({ label, value }) => (
                        <div key={label}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="mt-1 tabular-nums">{value.toLocaleString()}</dd>
                        </div>
                      ))}
                    </dl>
                    {info.error ? (
                      <Alert variant="destructive">
                        <CircleAlert />
                        <AlertDescription>
                          {info.error.name === "MessageOutputLengthError"
                            ? "The model reached its output limit."
                            : info.error.data.message}
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </>
                ) : null}
                {(part ? [part] : message.parts).map((item) => (
                  <TranscriptPart key={item.id} part={item} />
                ))}
                <dl className="text-muted-foreground grid gap-2 border-t pt-3 text-xs">
                  <div>
                    <dt>Session</dt>
                    <dd className="font-mono break-all">{session.session_id}</dd>
                  </div>
                  <div>
                    <dt>Message</dt>
                    <dd className="font-mono break-all">{message.info.id}</dd>
                  </div>
                  {part ? (
                    <div>
                      <dt>Part</dt>
                      <dd className="font-mono break-all">{part.id}</dd>
                    </div>
                  ) : null}
                  {part?.type === "tool" ? (
                    <div>
                      <dt>Call</dt>
                      <dd className="font-mono break-all">{part.callID}</dd>
                    </div>
                  ) : null}
                </dl>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function TranscriptPart({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse mode="static" plainCodeBlocks>
          {part.text}
        </MessageResponse>
      )
    case "reasoning":
      return (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground flex w-full items-center gap-2 text-sm">
            <Brain className="size-4" />
            Reasoning
            <ChevronDown className="ml-auto size-4" />
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <MessageResponse mode="static" plainCodeBlocks>
              {part.text}
            </MessageResponse>
          </CollapsibleContent>
        </Collapsible>
      )
    case "tool":
      return (
        <div className="flex min-w-0 flex-col gap-4">
          <section>
            <h4 className="mb-2 text-xs font-medium">Arguments</h4>
            <CodeBlock code={JSON.stringify(part.state.input, null, 2)} language="json" />
          </section>
          {part.state.status === "completed" ? (
            <section>
              <h4 className="mb-2 text-xs font-medium">
                Result ·{" "}
                {formatDurationSeconds((part.state.time.end - part.state.time.start) / 1000)}
              </h4>
              <pre className="bg-muted overflow-auto rounded-md p-3 text-xs wrap-break-word whitespace-pre-wrap">
                {part.state.output}
              </pre>
            </section>
          ) : null}
          {part.state.status === "error" ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{part.state.error}</AlertDescription>
            </Alert>
          ) : null}
          {part.state.status === "pending" || part.state.status === "running" ? (
            <p className="text-muted-foreground text-sm">Tool {part.state.status} when recorded.</p>
          ) : null}
          {part.state.status === "completed"
            ? part.state.attachments?.map((file) => (
                <Badge key={file.id} variant="outline">
                  <FileText />
                  {file.filename ?? file.mime}
                </Badge>
              ))
            : null}
        </div>
      )
    case "file":
      return (
        <Badge variant="outline">
          <FileText />
          {part.filename ?? part.mime}
        </Badge>
      )
    case "subtask":
      return (
        <section>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-medium">
            <GitBranch className="size-4" />
            {part.description}
          </h4>
          <MessageResponse mode="static" plainCodeBlocks>
            {part.prompt}
          </MessageResponse>
        </section>
      )
    case "agent":
      return (
        <Badge variant="secondary">
          <GitBranch />
          {part.name}
        </Badge>
      )
    case "patch":
      return (
        <section>
          <h4 className="mb-2 text-xs font-medium">Changed files</h4>
          <ul className="flex flex-col gap-1 text-xs">
            {part.files.map((file) => (
              <li key={file} className="font-mono break-all">
                {file}
              </li>
            ))}
          </ul>
        </section>
      )
    case "retry":
      return (
        <Alert>
          <CircleAlert />
          <AlertDescription>
            Retry {part.attempt}: {part.error.data.message}
          </AlertDescription>
        </Alert>
      )
    case "compaction":
      return <Badge variant="secondary">Context compacted</Badge>
    case "step-start":
      return <span className="text-muted-foreground text-xs">Step started</span>
    case "step-finish":
      return <span className="text-muted-foreground text-xs">Step finished · {part.reason}</span>
    case "snapshot":
      return (
        <span className="text-muted-foreground text-xs break-all">Snapshot {part.snapshot}</span>
      )
  }
}
