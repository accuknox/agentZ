"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { ArrowUpIcon, ChevronDownIcon, CornerUpLeftIcon, PaperclipIcon, XIcon } from "lucide-react"
import type { ChatInput, ChatInputUpdate } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { useOpencodeSend } from "./use-opencode-send"
import { cn } from "@/lib/utils"

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
      className="bg-muted/20 border-border/60 mx-3 mb-2 min-w-0 rounded-lg border px-2 py-1"
    >
      <button
        ref={heading}
        type="button"
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex h-7 items-center gap-1.5 rounded-md px-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
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
          <span className="text-muted-foreground/70 ml-1.5 tabular-nums">{count}</span>
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
                className="text-muted-foreground/60 size-3 shrink-0"
                aria-label="Queuing message"
              />
              {!props.coding ? (
                <span className="text-muted-foreground max-w-20 shrink-0 truncate text-xs">
                  You
                </span>
              ) : null}
              <p className="min-w-0 flex-1 truncate text-[13px] leading-5" title={text || preview}>
                {!text && input.files.length ? (
                  <PaperclipIcon className="text-muted-foreground mr-1.5 inline size-3 align-[-2px]" />
                ) : null}
                {preview}
              </p>
              {text && input.files.length ? (
                <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]">
                  <PaperclipIcon className="size-3" />
                  {input.files.length}
                </span>
              ) : null}
              <span className="text-muted-foreground shrink-0 text-[11px]">Queuing...</span>
            </div>
          )
        })}
      </div>
      {error ? (
        <p role="status" className="text-destructive px-1 py-1 text-xs">
          Could not synchronize messages. {error}
        </p>
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
  const preview =
    item.content.text.trim().split("\n", 1)[0] ||
    item.content.attachments.map((file) => file.filename).join(", ")
  const status =
    item.state === "recovered"
      ? recoveredOnly
        ? undefined
        : "Draft"
      : item.state === "failed"
        ? "Needs attention"
        : item.state === "sending" || item.delivery === "steer"
          ? "Sending"
          : undefined
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
      className="hover:bg-muted/50 focus-visible:ring-ring/50 rounded-lg px-1 outline-none focus-visible:ring-2"
    >
      <div className="flex min-h-8 items-center gap-2">
        <span className="text-muted-foreground/60 w-3 shrink-0 text-center text-[10px] tabular-nums">
          {item.state === "sending" ? <Spinner className="size-3" /> : index + 1}
        </span>
        {!coding ? (
          <span className="text-muted-foreground max-w-20 shrink-0 truncate text-xs">
            {owned ? "You" : (item.author.name ?? "Participant")}
          </span>
        ) : null}
        <p
          className="min-w-0 flex-1 truncate text-[13px] leading-5"
          title={`${item.content.text || item.content.attachments.map((file) => file.filename).join(", ")}\n${item.content.model.modelID}${item.content.agent ? ` · ${item.content.agent}` : ""}`}
        >
          {!item.content.text && item.content.attachments.length ? (
            <PaperclipIcon className="text-muted-foreground mr-1.5 inline size-3 align-[-2px]" />
          ) : null}
          {preview}
        </p>
        {item.content.text && item.content.attachments.length ? (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]">
            <PaperclipIcon className="size-3" />
            {item.content.attachments.length}
          </span>
        ) : null}
        {status ? (
          <span className="text-muted-foreground shrink-0 text-[11px]">{status}</span>
        ) : null}
        {owned && !locked ? (
          <div className="text-muted-foreground flex shrink-0 items-center">
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
        <p role="status" className="text-destructive mt-2 ml-6 text-xs">
          {error || item.error}
        </p>
      ) : null}
    </div>
  )
}
