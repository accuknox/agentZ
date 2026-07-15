"use client"

import { ChevronDownIcon, ChevronRightIcon, Redo2Icon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { PermissionRequest, QuestionAnswer, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useCallback, useEffect, useRef, useState } from "react"

const CUSTOM_ANSWER_KEY = "__custom__"
const QUESTION_CACHE_MAX = 8

// In-flight question answers survive navigation away and back within the same
// request id. Cleared on reply/reject so a future identical-looking request
// doesn't accidentally reuse a stale choice.
type QuestionCacheEntry = {
  answers: Record<number, string[]>
  custom: Record<number, string>
  customEnabled: Record<number, boolean>
  tab: number
}
const questionCache = new Map<string, QuestionCacheEntry>()
function rememberAnswer(requestID: string, entry: QuestionCacheEntry) {
  questionCache.delete(requestID)
  questionCache.set(requestID, entry)
  if (questionCache.size > QUESTION_CACHE_MAX) {
    const oldest = questionCache.keys().next().value
    if (oldest) questionCache.delete(oldest)
  }
}

function emptyAnswers(count: number): QuestionCacheEntry {
  return {
    answers: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, []])),
    custom: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, ""])),
    customEnabled: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, false])),
    tab: 0,
  }
}

function buildAnswers(entry: QuestionCacheEntry, request: QuestionRequest): QuestionAnswer[] {
  return request.questions.map((question, index) => {
    const selected = entry.answers[index] ?? []
    const custom = entry.custom[index]?.trim()

    if (question.multiple !== true) {
      return selected[0] === CUSTOM_ANSWER_KEY ? (custom ? [custom] : []) : selected.slice(0, 1)
    }

    const answers = selected.filter((item) => item !== CUSTOM_ANSWER_KEY)
    if ((entry.customEnabled[index] ?? false) && custom) answers.push(custom)
    return answers
  })
}

function AutoSizeTextarea({
  defaultValue,
  disabled,
  onCommit,
}: {
  defaultValue: string
  disabled: boolean
  onCommit: (value: string) => void
}) {
  const [value, setValue] = useState(defaultValue)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const resize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    resize()
  }, [resize])

  // Escape abandons the edit without committing, mirroring opencode's behaviour
  // so the Escape key stays usable inside the custom-answer field.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.currentTarget.parentElement
        ?.querySelector<HTMLElement>("button[data-question-dismiss]")
        ?.focus()
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "Enter") {
      event.preventDefault()
      onCommit(value)
      return
    }
  }

  return (
    <Textarea
      autoFocus
      ref={ref}
      aria-label="Custom answer"
      className="max-h-40 min-h-8 rounded-md px-2.5 py-1.5 text-base md:text-sm"
      disabled={disabled}
      onBlur={(event) => onCommit(event.target.value)}
      onChange={(event) => {
        setValue(event.target.value)
        resize()
      }}
      onKeyDown={handleKeyDown}
      placeholder="Type your own answer"
      rows={1}
      value={value}
    />
  )
}

export function QuestionDock({
  onReject,
  onSubmit,
  pending,
  request,
}: {
  onReject: () => void
  onSubmit: (answers: QuestionAnswer[]) => void
  pending: boolean
  request: QuestionRequest
}) {
  const [entry, setEntry] = useState<QuestionCacheEntry>(() => {
    const cached = questionCache.get(request.id)
    return cached ?? emptyAnswers(request.questions.length)
  })
  const repliedRef = useRef(false)

  const questions = request.questions
  const total = questions.length
  const tab = Math.min(entry.tab, total - 1)
  const question = questions[tab]
  const selected = entry.answers[tab]
  const isLast = tab === total - 1
  const answers = buildAnswers(entry, request)
  const currentAnswered = (answers[tab]?.length ?? 0) > 0 || (entry.customEnabled[tab] ?? false)

  const patch = useCallback(
    (next: Partial<QuestionCacheEntry>) => setEntry((prev) => ({ ...prev, ...next })),
    []
  )
  const patchAt = useCallback(
    (next: Partial<Pick<QuestionCacheEntry, "answers" | "custom" | "customEnabled">>) =>
      setEntry((prev) => ({
        ...prev,
        answers: next.answers ? { ...prev.answers, ...next.answers } : prev.answers,
        custom: next.custom ? { ...prev.custom, ...next.custom } : prev.custom,
        customEnabled: next.customEnabled
          ? { ...prev.customEnabled, ...next.customEnabled }
          : prev.customEnabled,
      })),
    []
  )

  const selectSingle = useCallback(
    (value: string) => {
      patchAt({
        answers: { [tab]: value ? [value] : [] },
        customEnabled: { [tab]: value === CUSTOM_ANSWER_KEY },
      })
    },
    [patchAt, tab]
  )
  const selectMulti = useCallback(
    (value: string) => {
      const current = selected ?? []
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
      patchAt({
        answers: { [tab]: next },
        customEnabled: { [tab]: next.includes(CUSTOM_ANSWER_KEY) },
      })
    },
    [patchAt, selected, tab]
  )
  const commitCustom = useCallback(
    (value: string) => {
      patchAt({ custom: { [tab]: value } })
    },
    [patchAt, tab]
  )

  const next = useCallback(() => {
    if (pending) return
    if (isLast) {
      repliedRef.current = true
      questionCache.delete(request.id)
      onSubmit(answers)
      return
    }
    patch({ tab: tab + 1 })
  }, [answers, isLast, onSubmit, patch, pending, request.id, tab])

  const back = useCallback(() => {
    if (pending || tab === 0) return
    patch({ tab: tab - 1 })
  }, [patch, pending, tab])

  const reject = useCallback(() => {
    if (pending) return
    repliedRef.current = true
    questionCache.delete(request.id)
    onReject()
  }, [onReject, pending, request.id])

  // Cache in-progress answers on unmount unless we replied or rejected. The
  // LRU keeps the most recent 8 requests in flight so navigating back and forth
  // within a session doesn't wipe half-answered dialogs.
  useEffect(() => {
    return () => {
      if (repliedRef.current) return
      rememberAnswer(request.id, entry)
    }
  }, [entry, request.id])

  // Row-level keys: Escape rejects, Cmd/Ctrl+Enter advances, Arrows/Home/End
  // move between options when focus is on a list row.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      reject()
      return
    }
    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }
    const target = event.target instanceof HTMLElement ? event.target : null
    const onOption = target?.closest("[data-question-option]") != null
    if (!onOption) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-question-option]")
    )
    const currentIndex = options.indexOf(target!)
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      options[Math.min(options.length - 1, currentIndex + 1)]?.focus()
      return
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      options[Math.max(0, currentIndex - 1)]?.focus()
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      options[0]?.focus()
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      options[options.length - 1]?.focus()
    }
  }

  if (!question) return null

  const customAllowed = question.custom !== false

  return (
    <div className="mx-auto w-full px-4 @xl/chat:w-4/5 @xl/chat:px-0">
      <div className="border-primary border-l-2">
        <div className="flex flex-col gap-4 px-4 py-3" onKeyDown={handleKeyDown}>
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="text-foreground min-w-0 text-sm font-medium wrap-break-word">
                {question.header}
              </div>
              <div className="text-muted-foreground font-mono text-[11px]">
                {tab + 1}/{total}
              </div>
            </div>
            <div className="flex gap-1.5">
              {questions.map((item, index) => {
                const answered =
                  (answers[index]?.length ?? 0) > 0 || (entry.customEnabled[index] ?? false)
                return (
                  <button
                    aria-label={`Go to question ${index + 1}`}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      index === tab ? "bg-foreground" : answered ? "bg-primary/60" : "bg-muted"
                    )}
                    disabled={pending}
                    key={`${item.header}-${index}`}
                    onClick={() => !pending && patch({ tab: index })}
                    type="button"
                  />
                )
              })}
            </div>
          </div>

          <div className="text-foreground text-sm wrap-break-word">
            {question.question}
            {question.multiple === true ? " Select all that apply." : ""}
          </div>

          <FieldGroup>
            {question.multiple === true ? (
              <div className="flex flex-col gap-3">
                {question.options.map((option, index) => (
                  <label
                    className="flex items-start gap-3"
                    data-question-option
                    key={`${option.label}-${index}`}
                    tabIndex={0}
                  >
                    <Checkbox
                      checked={(selected ?? []).includes(option.label)}
                      disabled={pending}
                      onCheckedChange={() => selectMulti(option.label)}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-foreground text-sm wrap-break-word">
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-sm wrap-break-word">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
                {customAllowed ? (
                  <label
                    className="flex items-start gap-3"
                    data-question-option
                    key={`${CUSTOM_ANSWER_KEY}-${question.options.length}`}
                    tabIndex={0}
                  >
                    <Checkbox
                      checked={(selected ?? []).includes(CUSTOM_ANSWER_KEY)}
                      disabled={pending}
                      onCheckedChange={() => selectMulti(CUSTOM_ANSWER_KEY)}
                    />
                    <span className="text-foreground flex flex-1 flex-col gap-2 text-sm">
                      Type your own answer
                      {(selected ?? []).includes(CUSTOM_ANSWER_KEY) ? (
                        <AutoSizeTextarea
                          defaultValue={entry.custom[tab] ?? ""}
                          disabled={pending}
                          key={`${request.id}:${tab}`}
                          onCommit={commitCustom}
                        />
                      ) : null}
                    </span>
                  </label>
                ) : null}
              </div>
            ) : (
              <RadioGroup
                className="flex flex-col gap-3"
                disabled={pending}
                onValueChange={selectSingle}
                value={selected?.[0] ?? ""}
              >
                {question.options.map((option, index) => (
                  <label
                    className="flex items-start gap-3"
                    data-question-option
                    key={`${option.label}-${index}`}
                    tabIndex={0}
                  >
                    <RadioGroupItem value={option.label} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-foreground text-sm wrap-break-word">
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-sm wrap-break-word">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
                {customAllowed ? (
                  <label
                    className="flex items-start gap-3"
                    data-question-option
                    key={`${CUSTOM_ANSWER_KEY}-${question.options.length}`}
                    tabIndex={0}
                  >
                    <RadioGroupItem value={CUSTOM_ANSWER_KEY} />
                    <span className="text-foreground flex flex-1 flex-col gap-2 text-sm">
                      Type your own answer
                      {selected?.[0] === CUSTOM_ANSWER_KEY ? (
                        <AutoSizeTextarea
                          defaultValue={entry.custom[tab] ?? ""}
                          disabled={pending}
                          key={`${request.id}:${tab}`}
                          onCommit={commitCustom}
                        />
                      ) : null}
                    </span>
                  </label>
                ) : null}
              </RadioGroup>
            )}
          </FieldGroup>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              data-question-dismiss
              disabled={pending}
              onClick={reject}
              type="button"
              variant="destructive"
            >
              Dismiss
            </Button>
            <div className="flex items-center gap-2 self-end">
              {tab > 0 ? (
                <Button disabled={pending} onClick={back} type="button" variant="secondary">
                  Back
                </Button>
              ) : null}
              <Button disabled={pending || !currentAnswered} onClick={next} type="button">
                {pending ? <Spinner /> : null}
                {isLast ? "Submit" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
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
      <div className="border-primary border-l-2">
        <div className="flex flex-col gap-4 px-4 py-3">
          <div className="flex flex-col gap-1">
            <div className="text-foreground text-sm font-medium">{permissionTitle(request)}</div>
            <div className="text-muted-foreground text-sm">{permissionDescription(request)}</div>
          </div>
          {request.patterns.length > 0 ? (
            <FieldSet>
              <FieldLegend>Patterns</FieldLegend>
              <div className="flex flex-col gap-1">
                {request.patterns.map((pattern) => (
                  <code
                    className="border-border bg-muted/40 w-fit max-w-full rounded px-1.5 py-0.5 font-mono text-xs wrap-break-word"
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
        className="border-destructive/30 bg-destructive/5 hover:bg-destructive/10 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="text-foreground shrink-0 text-sm font-medium">
          {items.length} reverted
        </span>
        {preview && !open ? (
          <span className="text-muted-foreground ml-1 min-w-0 truncate text-sm">
            {preview || "[attachment]"}
          </span>
        ) : null}
        {hasDiff ? (
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
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
        <div className="border-muted-foreground/15 mt-1 flex flex-col gap-1.5 border-l pl-3">
          {items.map((item) => (
            <div className="flex items-center gap-2" key={item.id}>
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">
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
        className="border-border bg-muted/30 hover:bg-muted/60 flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="text-foreground shrink-0 text-sm font-medium">
          {done}/{todos.length}
        </span>
        {preview && !open ? (
          <span className="text-muted-foreground ml-1 min-w-0 truncate text-sm">{preview}</span>
        ) : null}
      </button>
      {open ? (
        <div className="border-border border-muted-foreground/15 mt-1 flex flex-col gap-1 border-l pl-3">
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
                        ? "border-primary animate-pulse"
                        : "border-muted-foreground"
                  )}
                />
                <span
                  className={cn(
                    "text-foreground min-w-0 wrap-break-word",
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
