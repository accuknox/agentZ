"use client"

import { useQuery } from "@tanstack/react-query"
import { readAgentFileRawOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { useObjectURL } from "@/hooks/use-object-url"
import type { PromptInputFile } from "@/components/ai-elements/prompt-input"
import { useId, useRef, useState } from "react"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CornerUpLeftIcon,
  PaperclipIcon,
  PencilIcon,
  XIcon,
  CircleAlert,
} from "lucide-react"
import type { ChatInput, ChatInputUpdate } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import type { useOpencodeSend } from "./use-opencode-send"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription } from "@/components/ui/alert"

type ChatQueueProps = {
  items: ChatInput[]
  submissions: ReturnType<typeof useOpencodeSend>["pending"]
  error?: string
  userID?: string
  coding: boolean
  agentName: string
  workspaceId: string
  editingID?: string
  editDisabled: boolean
  sendDisabled: boolean
  onRestore: (item: ChatInput) => void
  onEdit: (item: ChatInput) => Promise<void>
  onUpdate: ReturnType<typeof useOpencodeSend>["updateInput"]
}

// The queue belongs to the timeline so it shares scrolling and reading anchors.
export function ChatQueue({ items, submissions, error, ...props }: ChatQueueProps) {
  const [expanded, setExpanded] = useState(false)
  const listID = useId()
  const acknowledged = new Set(items.map((item) => item.id))
  const pending = submissions.filter(({ id }) => !acknowledged.has(id))
  const count = items.length + pending.length
  if (!count && !error) return null
  const collapsed = count > 3 && !expanded
  const entries = [...items, ...pending]
  const visible = collapsed ? entries.slice(0, 2) : entries
  return (
    <section aria-label="Message queue" className="relative min-w-0 pb-4" data-thread-queue>
      <span className="sr-only" role="status">
        {count} queued
      </span>
      <ol id={listID} className="flex flex-col items-end gap-3">
        {visible.map((entry, index) => (
          <QueueRow key={entry.id} entry={entry} index={index} count={count} {...props} />
        ))}
      </ol>
      {count > 3 ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={listID}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") event.preventDefault()
            }}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDownIcon className={cn(expanded && "rotate-180")} />
            {expanded ? "Show fewer" : `Show all ${count} queued`}
          </Button>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="status">
          <CircleAlert />
          <AlertDescription>Could not synchronize messages. {error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}

function QueueRow({
  entry,
  agentName,
  workspaceId,
  index,
  count,
  userID,
  coding,
  editingID,
  editDisabled,
  sendDisabled,
  onUpdate,
  onEdit,
  onRestore,
}: Omit<ChatQueueProps, "items" | "submissions" | "error"> & {
  entry: ChatInput | ChatQueueProps["submissions"][number]
  index: number
  count: number
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const item = "input" in entry ? undefined : entry
  const text = "input" in entry ? entry.input.text : entry.content.text
  const files = "input" in entry ? entry.input.files : entry.content.attachments
  const owned = !item || item.author.id === userID
  const locked = !item || item.state === "sending" || Boolean(item.message_id)
  const editing = entry.id === editingID
  let status: string | undefined
  if (item?.state === "recovered") status = "Unsent draft"
  if (item?.state === "failed") status = "Needs attention"
  if (item && locked) status = "Sending"
  const change = async (action: ChatInputUpdate["action"]) => {
    if (!item || inFlight.current) return
    inFlight.current = true
    setError("")
    setPending(true)
    try {
      await onUpdate({ item, action })
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update message")
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <li
      aria-label={`Queued message ${index + 1} of ${count}, not sent`}
      aria-posinset={index + 1}
      aria-setsize={count}
      aria-current={editing ? "true" : undefined}
      className="group/queued flex w-full flex-col items-end gap-1"
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl border-2 border-dashed border-muted-foreground/40 px-4 py-2.5 text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
          editing && "border-primary/60 text-foreground"
        )}
      >
        {!coding && item && !owned ? (
          <p className="mb-1 text-xs text-muted-foreground">{item.author.name}</p>
        ) : null}
        <p className="text-sm leading-6 break-words whitespace-pre-wrap">{text}</p>
        {files.length ? (
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-muted-foreground">
            {files.map((file, index) => (
              <QueueAttachment
                key={index}
                file={file}
                agentName={agentName}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex h-7 items-center gap-1 text-xs text-muted-foreground">
        {status ? <span className="px-1">{status}</span> : null}
        {item && owned && !locked ? (
          <>
            {item.state === "recovered" ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Restore draft to composer"
                title="Restore to composer"
                disabled={pending || editDisabled}
                onClick={() => onRestore(item)}
              >
                <CornerUpLeftIcon />
              </Button>
            ) : null}
            {item.state === "queued" ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label="Send queued message now"
                  title="Send now"
                  disabled={pending || sendDisabled || editing}
                  onClick={() => void change("steer")}
                >
                  <ArrowUpIcon />
                  Send now
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Edit queued message"
                  title="Edit"
                  disabled={pending || editDisabled}
                  onClick={() => void onEdit(item)}
                >
                  <PencilIcon />
                </Button>
              </>
            ) : null}
            {item.state === "failed" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void change("retry")}
              >
                <ArrowUpIcon />
                Retry
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="hover:text-destructive"
              aria-label="Remove queued message"
              title="Remove"
              disabled={pending || editing}
              onClick={() => void change("remove")}
            >
              <XIcon />
            </Button>
          </>
        ) : null}
      </div>
      {error || item?.error ? (
        <Alert variant="destructive" className="mt-1" role="status">
          <CircleAlert />
          <AlertDescription>{error || item?.error}</AlertDescription>
        </Alert>
      ) : null}
    </li>
  )
}

function QueueAttachment({
  file,
  agentName,
  workspaceId,
}: {
  file: ChatInput["content"]["attachments"][number] | PromptInputFile
  agentName: string
  workspaceId: string
}) {
  const local = "source" in file && file.source === "local" ? file : undefined
  const image = file.mediaType.startsWith("image/")
  const preview = useQuery({
    ...readAgentFileRawOptions({
      headers: { "X-AgentZ-Workspace-ID": workspaceId },
      parseAs: "blob",
      path: { agentName },
      query: { path: "path" in file ? file.path : "" },
    }),
    enabled: image && !local,
    gcTime: 0,
  })
  const remoteURL = useObjectURL(preview.data)
  const url = local?.url ?? remoteURL
  return (
    <span className="inline-flex items-center gap-1.5" title={file.filename}>
      {image ? (
        <span className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- local and authenticated blob previews
            <img src={url} alt={file.filename} className="size-8 object-cover" />
          ) : (
            <PaperclipIcon className="size-3" />
          )}
        </span>
      ) : (
        <PaperclipIcon className="size-3" />
      )}
      <span className="max-w-40 truncate">{file.filename}</span>
    </span>
  )
}
