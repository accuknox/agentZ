"use client"

import { useLayoutEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  PaperclipIcon,
  XIcon,
  CircleAlert,
} from "lucide-react"
import type { ChatInput, ChatInputUpdate } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { useOpencodeSend } from "./use-opencode-send"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"

type ChatQueueProps = {
  items: ChatInput[]
  submissions: ReturnType<typeof useOpencodeSend>["pending"]
  error?: string
  userID?: string
  coding: boolean
  onRestore: (item: ChatInput) => void
  onUpdate: ReturnType<typeof useOpencodeSend>["updateInput"]
}

export function ChatQueue({ items, submissions, error, ...props }: ChatQueueProps) {
  const [expanded, setExpanded] = useState(true)
  const latestSubmission = submissions.at(-1)?.id
  const [lastSubmission, setLastSubmission] = useState(latestSubmission)
  const heading = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (latestSubmission && list.current) {
      list.current.scrollTop = list.current.scrollHeight
    }
  }, [latestSubmission])
  // A new submission reveals its progress even if the queue was collapsed.
  if (latestSubmission !== lastSubmission) {
    setLastSubmission(latestSubmission)
    if (latestSubmission) setExpanded(true)
  }
  const pending = submissions.filter(({ id }) => !items.some((item) => item.id === id))
  const count = items.length + pending.length
  if (!count && !error) return null
  const recoveredOnly =
    !pending.length && items.length > 0 && items.every((item) => item.state === "recovered")
  return (
    <section
      aria-label="Message queue"
      className="mx-3 mb-2 min-w-0 rounded-lg border border-border/60 bg-muted/20 px-2 py-1"
    >
      <button
        ref={heading}
        type="button"
        aria-expanded={expanded}
        className="flex h-7 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 transition-transform motion-reduce:transition-none",
            !expanded && "-rotate-90"
          )}
        />
        <span className="font-medium" aria-live="polite" aria-atomic="true">
          {recoveredOnly ? "Unsent drafts" : "Queued"}
          <span className="ml-1.5 text-muted-foreground/70 tabular-nums">{count}</span>
        </span>
      </button>
      <div hidden={!expanded} ref={list} className="max-h-44 overflow-y-auto overscroll-contain">
        {items.map((item, index) => (
          <QueueRow
            key={item.id}
            item={item}
            index={index}
            recoveredOnly={recoveredOnly}
            {...props}
            onUpdate={async (input) => {
              const result = await props.onUpdate(input)
              if (input.action === "remove") heading.current?.focus()
              return result
            }}
          />
        ))}
        {pending.map(({ id, input }) => {
          const text = input.text.trim()
          const preview =
            text.split("\n", 1)[0] || input.files.map((file) => file.filename).join(", ")
          return (
            <div key={id} className="flex min-h-8 items-center gap-2 px-1" aria-busy="true">
              <Spinner
                className="size-3 shrink-0 text-muted-foreground/60"
                aria-label="Queuing message"
              />
              {!props.coding ? (
                <span className="max-w-20 shrink-0 truncate text-xs text-muted-foreground">
                  You
                </span>
              ) : null}
              <p className="min-w-0 flex-1 truncate text-[13px] leading-5" title={text || preview}>
                {!text && input.files.length ? (
                  <PaperclipIcon className="mr-1.5 inline size-3 align-[-2px] text-muted-foreground" />
                ) : null}
                {preview}
              </p>
              {text && input.files.length ? (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <PaperclipIcon className="size-3" />
                  {input.files.length}
                </span>
              ) : null}
              <span className="shrink-0 text-[11px] text-muted-foreground">Queuing...</span>
            </div>
          )
        })}
      </div>
      {error ? (
        <Alert variant="destructive" className="px-1 py-1" role="status">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>Could not synchronize messages. {error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}

function QueueRow({
  item,
  index,
  recoveredOnly,
  userID,
  coding,
  onUpdate,
  onRestore,
}: Omit<ChatQueueProps, "items" | "submissions" | "error"> & {
  item: ChatInput
  index: number
  recoveredOnly: boolean
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const rowRef = useRef<HTMLDivElement>(null)
  const owned = item.author.id === userID
  const locked = item.state === "sending" || Boolean(item.message_id)
  const filenames = item.content.attachments.map((file) => file.filename).join(", ")
  const preview = item.content.text.trim().split("\n", 1)[0] || filenames
  const model = item.content.model.modelID
  const agent = item.content.agent ? ` · ${item.content.agent}` : ""
  let status: string | undefined
  switch (item.state) {
    case "recovered":
      if (!recoveredOnly) status = "Draft"
      break
    case "failed":
      status = "Needs attention"
      break
    default:
      if (item.state === "sending" || item.delivery === "steer") status = "Sending"
  }
  const change = async (action: ChatInputUpdate["action"]) => {
    if (pending) return
    setError("")
    setPending(true)
    try {
      await onUpdate({ item, action })
      if (action !== "remove") rowRef.current?.focus()
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update message")
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className="rounded-lg px-1 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex min-h-8 items-center gap-2">
        <span className="w-3 shrink-0 text-center text-[10px] text-muted-foreground/60 tabular-nums">
          {item.state === "sending" ? <Spinner className="size-3" /> : index + 1}
        </span>
        {!coding ? (
          <span className="max-w-20 shrink-0 truncate text-xs text-muted-foreground">
            {owned ? "You" : (item.author.name ?? "Participant")}
          </span>
        ) : null}
        <p
          className="min-w-0 flex-1 truncate text-[13px] leading-5"
          title={`${item.content.text || filenames}\n${model}${agent}`}
        >
          {!item.content.text && item.content.attachments.length ? (
            <PaperclipIcon className="mr-1.5 inline size-3 align-[-2px] text-muted-foreground" />
          ) : null}
          {preview}
        </p>
        {item.content.text && item.content.attachments.length ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <PaperclipIcon className="size-3" />
            {item.content.attachments.length}
          </span>
        ) : null}
        {status ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">{status}</span>
        ) : null}
        {owned && !locked ? (
          <div className="flex shrink-0 items-center text-muted-foreground">
            {item.state === "recovered" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Restore draft to composer"
                title="Restore to composer"
                onClick={() => onRestore(item)}
              >
                <CornerUpLeftIcon className="size-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="hover:text-destructive"
              aria-label="Remove queued message"
              title="Remove"
              disabled={pending}
              onClick={() => void change("remove")}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      {item.state === "failed" && owned && !locked ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-6"
          disabled={pending}
          onClick={() => void change("retry")}
        >
          <ArrowUpIcon className="size-3.5" />
          Retry
        </Button>
      ) : null}
      {error || item.error ? (
        <Alert variant="destructive" className="mt-2 ml-6 w-auto" role="status">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error || item.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
