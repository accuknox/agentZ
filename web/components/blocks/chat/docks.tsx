"use client"

import {
  CheckIcon,
  ChevronDownIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  ChevronRightIcon,
  HammerIcon,
  PencilRulerIcon,
  Redo2Icon,
  CircleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { createAgentOpencodeClient } from "@/lib/opencode/client"
import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { FieldSet, FieldLegend } from "@/components/ui/field"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type {
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  Session,
  Todo,
} from "@opencode-ai/sdk/v2"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"

const CUSTOM_ANSWER_KEY = "__custom__"
const QUESTION_CACHE_MAX = 8

// In-flight question answers survive navigation away and back within the same
// request id. Cleared on reply/reject so a future identical-looking request
// doesn't accidentally reuse a stale choice.
type QuestionCacheEntry = {
  answers: Record<number, string[]>
  custom: Record<number, string>
  tab: number
}
const questionCache = new Map<string, QuestionCacheEntry>()

export function PlanDock({
  agentName,
  workspaceId,
  session,
  request,
  pending,
  onSubmit,
}: {
  agentName: string
  workspaceId: string
  session: Session
  request: QuestionRequest
  pending: boolean
  onSubmit: (answers: QuestionAnswer[]) => void
}) {
  // OpenCode's Session.plan names coding-worktree plans from session metadata.
  // Each approval request gets a fresh read, including after plan revisions.
  const path = `.opencode/plans/${session.time.created}-${session.slug}.md`
  const plan = useQuery(
    queryOptions({
      queryKey: ["opencode-plan", workspaceId, agentName, session.directory, path, request.id],
      queryFn: async ({ signal }) => {
        const client = await createAgentOpencodeClient(agentName, workspaceId)
        const { data } = await client.file.read(
          { directory: session.directory, path },
          { signal, throwOnError: true }
        )
        if (!data.content.trim()) throw new Error("The plan file is empty or missing.")
        return data.content
      },
      refetchOnWindowFocus: false,
      retry: false,
    })
  )

  return (
    <section aria-label="Plan review" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <PencilRulerIcon className="size-4 text-muted-foreground" />
          Review plan
        </h3>
        {plan.data ? <CopyButton content={plan.data} label="Copy plan" /> : null}
      </div>
      <div
        aria-label="Plan content"
        className="max-h-[min(24rem,45svh)] overflow-auto overscroll-contain px-4 py-4 sm:px-5"
        role="region"
        tabIndex={0}
      >
        {plan.isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Spinner className="size-4" />
            Loading plan...
          </div>
        ) : plan.isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>Could not load the plan.</AlertDescription>
            <Button
              disabled={plan.isFetching}
              onClick={() => void plan.refetch()}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </Alert>
        ) : (
          <MessageResponse mode="static">{plan.data}</MessageResponse>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
        <Button disabled={pending} onClick={() => onSubmit([["No"]])} size="sm" variant="ghost">
          Keep planning
        </Button>
        <Button
          disabled={pending || plan.isFetching || plan.isError || !plan.data}
          onClick={() => onSubmit([["Yes"]])}
          size="sm"
        >
          {pending ? <Spinner /> : <HammerIcon />}
          Implement plan
        </Button>
      </div>
    </section>
  )
}

export function QuestionDock({
  onReject,
  onSubmit,
  pending,
  request,
}: {
  onReject: () => Promise<void>
  onSubmit: (answers: QuestionAnswer[]) => Promise<void>
  pending: boolean
  request: QuestionRequest
}) {
  const [entry, setEntry] = useState<QuestionCacheEntry>(
    () => questionCache.get(request.id) ?? { answers: {}, custom: {}, tab: 0 }
  )
  const [open, setOpen] = useState(true)
  const replied = useRef(false)
  const customOption = useRef<HTMLInputElement>(null)
  const customText = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const { questions } = request
  const tab = Math.min(entry.tab, questions.length - 1)
  const question = questions[tab]
  const selected = entry.answers[tab] ?? []
  const answers = questions.map((_, index) => {
    const selected = entry.answers[index] ?? []
    const answers = selected.filter((value) => value !== CUSTOM_ANSWER_KEY)
    const custom = entry.custom[index]?.trim()
    if (selected.includes(CUSTOM_ANSWER_KEY) && custom) answers.push(custom)
    return answers
  })
  const complete = questions.map((_, index) => {
    const selected = entry.answers[index] ?? []
    return (
      selected.length > 0 &&
      (!selected.includes(CUSTOM_ANSWER_KEY) || Boolean(entry.custom[index]?.trim()))
    )
  })
  const allAnswered = complete.every(Boolean)
  const isLast = tab === questions.length - 1

  // Keep drafts through navigation and failed requests. Only an accepted reply
  // or dismissal clears them; the cache holds at most eight active requests.
  useEffect(
    () => () => {
      if (replied.current) return
      questionCache.delete(request.id)
      questionCache.set(request.id, entry)
      if (questionCache.size > QUESTION_CACHE_MAX) {
        const oldest = questionCache.keys().next().value
        if (oldest) questionCache.delete(oldest)
      }
    },
    [entry, request.id]
  )

  const advance = async () => {
    if (pending || !complete[tab]) return
    if (!isLast || !allAnswered) {
      setEntry((current) => ({ ...current, tab: isLast ? complete.indexOf(false) : tab + 1 }))
      return
    }
    try {
      await onSubmit(answers)
      replied.current = true
      questionCache.delete(request.id)
    } catch {
      // The mutation reports the error; keep the selected answers for retry.
    }
  }
  const reject = async () => {
    if (pending) return
    try {
      await onReject()
      replied.current = true
      questionCache.delete(request.id)
    } catch {
      // Dismissal failures retain the same draft as submission failures.
    }
  }
  if (!question) return null
  const options =
    question.custom !== false
      ? [...question.options, { label: CUSTOM_ANSWER_KEY, description: "" }]
      : question.options
  const select = (value: string) => {
    if (pending) return
    setEntry((current) => {
      const selected = current.answers[tab] ?? []
      return {
        ...current,
        answers: {
          ...current.answers,
          [tab]: question.multiple
            ? selected.includes(value)
              ? selected.filter((item) => item !== value)
              : [...selected, value]
            : [value],
        },
      }
    })
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mx-auto mb-2 w-full max-w-3xl overflow-clip rounded-xl border bg-card shadow-xs"
    >
      <section
        aria-label="Agent questions"
        aria-busy={pending}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || pending)
            return
          if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "Enter") {
            event.preventDefault()
            if (open) void advance()
            return
          }
          if (event.target === customText.current) return
          if (event.key === "Escape") {
            event.preventDefault()
            void reject()
            return
          }
          if (!open || event.metaKey || event.ctrlKey || event.altKey) return
          const option = options.find((_, index) => index < 9 && event.key === `${index + 1}`)
          if (option) {
            event.preventDefault()
            select(option.label)
          }
        }}
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
          <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="mr-auto min-w-0 truncate font-medium">{question.header}</span>
          {!open ? <span className="min-w-0 flex-1 truncate">{question.question}</span> : null}
          {questions.length > 1 ? (
            <span className="shrink-0 tabular-nums">
              {tab + 1} of {questions.length}
            </span>
          ) : null}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {questions.length > 1 ? (
            <nav aria-label="Questions" className="flex gap-1 overflow-x-auto border-t px-3 py-2">
              {questions.map((item, index) => (
                <button
                  aria-current={index === tab ? "step" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                    index === tab
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50"
                  )}
                  disabled={pending}
                  key={index}
                  type="button"
                  onClick={() => setEntry((current) => ({ ...current, tab: index }))}
                >
                  {complete[index] ? (
                    <CheckIcon aria-hidden="true" className="size-3" />
                  ) : (
                    <span className="tabular-nums">{index + 1}</span>
                  )}
                  <span>{item.header}</span>
                </button>
              ))}
            </nav>
          ) : null}
          <div className="max-h-[min(26rem,40svh)] overflow-y-auto overscroll-contain px-3 pb-3">
            <p id={`${id}-question`} className="px-0.5 pb-2 text-sm leading-relaxed break-words">
              {question.question}
            </p>
            {question.multiple ? (
              <p className="px-0.5 pb-2 text-xs text-muted-foreground">Select all that apply.</p>
            ) : null}
            <fieldset
              aria-labelledby={`${id}-question`}
              disabled={pending}
              className="min-w-0 space-y-1"
            >
              {options.map((option, index) => {
                const custom = option.label === CUSTOM_ANSWER_KEY
                const checked = selected.includes(option.label)
                return (
                  <div
                    key={`${tab}:${option.label}`}
                    className={cn(
                      "rounded-lg transition-colors has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-primary/30 has-[:focus-visible]:ring-inset",
                      checked ? "bg-primary/5" : "hover:bg-muted/50",
                      pending && "opacity-50"
                    )}
                  >
                    <label
                      className={cn(
                        "relative flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2",
                        pending && "cursor-default"
                      )}
                    >
                      <input
                        className="sr-only"
                        name={`${id}-${tab}`}
                        type={question.multiple ? "checkbox" : "radio"}
                        checked={checked}
                        onChange={() => select(option.label)}
                        ref={custom ? customOption : undefined}
                        value={option.label}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-sm", checked && "font-medium")}>
                          {custom ? "Write your own answer" : option.label}
                        </span>
                        {!custom && option.description && option.description !== option.label ? (
                          <span className="mt-0.5 block text-xs leading-relaxed break-words text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {checked ? (
                        <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      ) : custom ? (
                        <PencilIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      ) : index < 9 ? (
                        <kbd
                          aria-hidden="true"
                          className="w-4 shrink-0 text-center font-sans text-[11px] text-muted-foreground tabular-nums"
                        >
                          {index + 1}
                        </kbd>
                      ) : null}
                    </label>
                    {custom && checked ? (
                      <Textarea
                        autoFocus
                        ref={customText}
                        aria-label="Custom answer"
                        className="field-sizing-content max-h-32 min-h-9 resize-none scroll-mb-3 rounded-none border-0 pt-0 pb-2.5 focus-visible:ring-0 dark:bg-transparent"
                        disabled={pending}
                        rows={1}
                        placeholder="Your answer..."
                        value={entry.custom[tab] ?? ""}
                        onFocus={(event) =>
                          event.currentTarget.scrollIntoView({ block: "nearest" })
                        }
                        onChange={(event) =>
                          setEntry((current) => ({
                            ...current,
                            custom: { ...current.custom, [tab]: event.target.value },
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return
                          if (event.key === "Escape") {
                            event.preventDefault()
                            event.stopPropagation()
                            customOption.current?.focus()
                          }
                        }}
                      />
                    ) : null}
                  </div>
                )
              })}
            </fieldset>
          </div>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <Button disabled={pending} onClick={() => void reject()} size="sm" variant="ghost">
              Dismiss
            </Button>
            <div className="flex items-center gap-1.5">
              {tab > 0 ? (
                <Button
                  disabled={pending}
                  onClick={() => setEntry((current) => ({ ...current, tab: tab - 1 }))}
                  size="sm"
                  variant="ghost"
                >
                  Back
                </Button>
              ) : null}
              <Button disabled={pending || !complete[tab]} onClick={() => void advance()} size="sm">
                {pending ? <Spinner aria-hidden="true" /> : null}
                {questions.length === 1
                  ? "Submit answer"
                  : isLast
                    ? allAnswered
                      ? "Submit answers"
                      : "Next unanswered"
                    : "Continue"}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function permissionTitle(request: PermissionRequest): string {
  switch (request.permission) {
    case "edit":
      return "Edit files"
    case "read":
      return "Read files"
    case "glob":
      return "Match files"
    case "grep":
      return "Search file contents"
    case "list":
      return "List directory contents"
    case "task":
      return "Spawn subagent task"
    case "webfetch":
      return "Fetch web page"
    case "websearch":
      return "Search the web"
    case "external_directory":
      return "Access external directory"
    case "doom_loop":
      return "Continue after repeated failures"
    default:
      return `Call tool ${request.permission}`
  }
}

function permissionDescription(request: PermissionRequest): string {
  const meta = request.metadata ?? {}
  switch (request.permission) {
    case "edit":
      return typeof meta.filepath === "string" ? `Target: ${meta.filepath}` : "Modify files"
    case "read":
      return typeof meta.filepath === "string" ? `Path: ${meta.filepath}` : "Read a file"
    case "glob":
      return request.patterns[0] ? `Pattern: ${request.patterns[0]}` : "Match files by glob"
    case "grep":
      return request.patterns[0] ? `Pattern: ${request.patterns[0]}` : "Search file contents"
    case "list":
      return request.patterns[0] ? `Path: ${request.patterns[0]}` : "List directory contents"
    case "task":
      return typeof meta.description === "string" ? meta.description : "Delegate work to a subagent"
    case "webfetch":
      return request.patterns[0] ? `URL: ${request.patterns[0]}` : "Fetch a web page"
    case "websearch":
      return request.patterns[0] ? `Query: ${request.patterns[0]}` : "Search the web"
    case "external_directory":
      return request.patterns[0]
        ? `Pattern: ${request.patterns[0]}`
        : "Access a directory outside the workspace"
    case "doom_loop":
      return "Keep the run going despite repeated failures"
    default:
      return `Permission: ${request.permission}`
  }
}

export type PermissionDecision = "always" | "once" | "reject"

export function PermissionDock({
  onDecide,
  pending,
  request,
}: {
  onDecide: (reply: PermissionDecision) => void
  pending: boolean
  request: PermissionRequest
}) {
  const decide = useCallback(
    (reply: PermissionDecision) => {
      if (pending) return
      onDecide(reply)
    },
    [onDecide, pending]
  )

  return (
    <div className="mx-auto w-full px-4 @xl/chat:w-4/5 @xl/chat:px-0">
      <div className="border-l-2 border-primary">
        <div className="flex flex-col gap-4 px-4 py-3">
          <div className="flex flex-col gap-1">
            <div className="text-sm font-medium text-foreground">{permissionTitle(request)}</div>
            <div className="text-sm text-muted-foreground">{permissionDescription(request)}</div>
          </div>
          {request.patterns.length > 0 ? (
            <FieldSet>
              <FieldLegend>Patterns</FieldLegend>
              <div className="flex flex-col gap-1">
                {request.patterns.map((pattern) => (
                  <code
                    className="w-fit max-w-full rounded border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs wrap-break-word"
                    key={pattern}
                  >
                    {pattern}
                  </code>
                ))}
              </div>
            </FieldSet>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              disabled={pending}
              onClick={() => decide("reject")}
              type="button"
              variant="destructive"
            >
              Deny
            </Button>
            <div className="flex items-center gap-2 self-end">
              <Button
                disabled={pending}
                onClick={() => decide("always")}
                type="button"
                variant="secondary"
              >
                Always allow
              </Button>
              <Button disabled={pending} onClick={() => decide("once")} type="button">
                {pending ? <Spinner /> : null}
                Allow once
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function RevertDock({
  items,
  onRestore,
  pending,
  restoringId,
  summary,
}: {
  items: { id: string; text: string }[]
  onRestore: (id: string) => void
  pending: boolean
  restoringId?: string
  summary?: { additions: number; deletions: number; files: number }
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null

  const preview = items[0]?.text
  const hasDiff = summary !== undefined && summary.files > 0

  return (
    <div className="mx-auto w-full px-4 pb-1 @xl/chat:w-4/5 @xl/chat:px-0">
      <button
        className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-left transition-colors hover:bg-destructive/10"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-sm font-medium text-foreground">
          {items.length} reverted
        </span>
        {preview && !open ? (
          <span className="ml-1 min-w-0 truncate text-sm text-muted-foreground">
            {preview || "[attachment]"}
          </span>
        ) : null}
        {hasDiff ? (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {summary.files} {summary.files === 1 ? "file" : "files"}
            {summary.additions > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400"> +{summary.additions}</span>
            ) : null}
            {summary.deletions > 0 ? (
              <span className="text-destructive"> −{summary.deletions}</span>
            ) : null}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1.5 border-l border-muted-foreground/15 pl-3">
          {items.map((item) => (
            <div className="flex items-center gap-2" key={item.id}>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {item.text || "[attachment]"}
              </span>
              <Button
                aria-label="Restore message"
                className="h-6 w-6 shrink-0"
                disabled={pending}
                onClick={() => onRestore(item.id)}
                size="icon"
                type="button"
                variant="ghost"
              >
                {restoringId === item.id ? (
                  <Spinner className="size-4" />
                ) : (
                  <Redo2Icon className="h-4 w-4" />
                )}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TodoDock({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false)
  if (todos.length === 0) return null

  const done = todos.filter((todo) => todo.status === "completed").length
  const inProgress = todos.find(
    (todo) => todo.status === "in_progress" || todo.status === "pending"
  )
  const preview = inProgress ? inProgress.content : todos[0]?.content

  return (
    <div className="mx-auto w-full px-4 pb-1 @xl/chat:w-4/5 @xl/chat:px-0">
      <button
        className="flex w-full items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/60"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-sm font-medium text-foreground">
          {done}/{todos.length}
        </span>
        {preview && !open ? (
          <span className="ml-1 min-w-0 truncate text-sm text-muted-foreground">{preview}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-l border-border border-muted-foreground/15 pl-3">
          {todos.map((todo, index) => {
            const terminal = todo.status === "completed" || todo.status === "cancelled"
            return (
              <div className="flex items-start gap-2 text-sm" key={`${todo.content}-${index}`}>
                <span
                  className={cn(
                    "mt-0.5 size-2.5 shrink-0 rounded-full border",
                    terminal
                      ? "border-primary bg-primary"
                      : todo.status === "in_progress"
                        ? "animate-pulse border-primary"
                        : "border-muted-foreground"
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 wrap-break-word text-foreground",
                    terminal ? "text-muted-foreground line-through" : undefined
                  )}
                >
                  {todo.content}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
