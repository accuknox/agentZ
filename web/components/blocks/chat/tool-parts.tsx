"use client"

import { CodeBlockContent } from "@/components/ai-elements/code-block"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { QuestionAnswer, QuestionInfo, ToolPart, Todo } from "@opencode-ai/sdk/v2"
import {
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderSearch2Icon,
  GlobeIcon,
  ListIcon,
  MessageSquareQuoteIcon,
  SearchIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { BundledLanguage } from "shiki"
import { useMemo, useState } from "react"

type ToolEntry =
  | { type: "tool"; key: string; part: ToolPart }
  | { type: "context"; key: string; parts: ToolPart[] }

type ToolProps = {
  agentName: string
  part: ToolPart
}

const contextTools = new Set(["read", "glob", "grep", "list"])
const genericToolPrimaryKeys = new Set([
  "description",
  "query",
  "url",
  "filePath",
  "path",
  "pattern",
  "name",
])

type ToolFile = {
  additions: number
  after?: string
  before?: string
  deletions: number
  filePath: string
  movePath?: string
  patch?: string
  relativePath: string
  type: "add" | "delete" | "move" | "update"
}

type ToolTone = "active" | "error" | "neutral"

type TriggerProps = {
  action?: React.ReactNode
  arg?: React.ReactNode
  href?: string
  pending?: boolean
  title: React.ReactNode
  tone?: ToolTone
}

type ToolCardProps = TriggerProps & {
  children?: React.ReactNode
  defaultOpen?: boolean
  hideDetails?: boolean
}

type Diagnostic = {
  message: string
  range: {
    end: { character: number; line: number }
    start: { character: number; line: number }
  }
  severity?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function fileName(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function directoryName(path: string) {
  const normalized = path.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index > 0 ? normalized.slice(0, index) : "/"
}

function titleCase(value: string) {
  return value[0] ? value[0].toUpperCase() + value.slice(1) : value
}

function truncate(value: string | undefined, max = 56) {
  if (!value) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function isToolVisible(part: ToolPart) {
  if (part.tool === "todowrite") return false
  if (part.tool === "question") {
    return part.state.status !== "pending" && part.state.status !== "running"
  }
  return true
}

function groupTools(parts: ToolPart[]) {
  const result: ToolEntry[] = []
  let group: ToolPart[] = []

  const flush = () => {
    if (group.length === 0) return
    if (group.length === 1) {
      const [part] = group
      if (part) result.push({ type: "tool", key: part.id, part })
    } else {
      result.push({
        type: "context",
        key: group.map((part) => part.id).join(":"),
        parts: group,
      })
    }
    group = []
  }

  for (const part of parts.filter(isToolVisible)) {
    if (contextTools.has(part.tool)) {
      group.push(part)
      continue
    }

    flush()
    result.push({ type: "tool", key: part.id, part })
  }

  flush()
  return result
}

function toolStateTone(status: ToolPart["state"]["status"]): ToolTone {
  switch (status) {
    case "pending":
    case "running":
      return "active"
    case "error":
      return "error"
    default:
      return "neutral"
  }
}

function toolMetadata(part: ToolPart) {
  const { metadata } = part.state as { metadata?: unknown }
  return record(metadata) ? metadata : undefined
}

function toneClass(tone: ToolTone) {
  switch (tone) {
    case "active":
      return "text-chat-active"
    case "error":
      return "text-chat-error"
    default:
      return "text-foreground"
  }
}

function webSearchProviderLabel(provider: string | undefined) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function urls(text: string | undefined) {
  if (!text) return []

  const seen = new Set<string>()

  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function loadedFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function toolFiles(value: unknown): ToolFile[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!record(item)) return []

    const filePath = stringValue(item.filePath)
    const relativePath = stringValue(item.relativePath) ?? filePath
    const type = item.type

    if (!filePath || !relativePath) return []
    if (type !== "add" && type !== "delete" && type !== "move" && type !== "update") return []

    return [
      {
        additions: numberValue(item.additions) ?? 0,
        after: stringValue(item.after),
        before: stringValue(item.before),
        deletions: numberValue(item.deletions) ?? 0,
        filePath,
        movePath: stringValue(item.movePath),
        patch: stringValue(item.patch) ?? stringValue(item.diff),
        relativePath,
        type,
      },
    ]
  })
}

function diagnosticsByPath(value: unknown, filePath: string | undefined) {
  if (!filePath || !record(value)) return []

  const entries = value[filePath]
  if (!Array.isArray(entries)) return []

  return entries.filter((item): item is Diagnostic => {
    return (
      record(item) &&
      record(item.range) &&
      record(item.range.start) &&
      record(item.range.end) &&
      typeof item.message === "string" &&
      typeof item.range.start.line === "number" &&
      typeof item.range.start.character === "number" &&
      typeof item.range.end.line === "number" &&
      typeof item.range.end.character === "number"
    )
  })
}

function isQuestionInfo(value: unknown): value is QuestionInfo {
  return record(value) && typeof value.header === "string" && typeof value.question === "string"
}

function questionInfos(value: unknown) {
  return Array.isArray(value) ? value.filter(isQuestionInfo) : []
}

function isQuestionAnswer(value: unknown): value is QuestionAnswer {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function questionAnswers(value: unknown) {
  return Array.isArray(value) ? value.filter(isQuestionAnswer) : []
}

function isTodo(value: unknown): value is Todo {
  return record(value) && typeof value.content === "string" && typeof value.status === "string"
}

function todos(value: unknown) {
  return Array.isArray(value) ? value.filter(isTodo) : []
}

function shellTranscript(part: ToolPart) {
  const cmd = stringValue(part.state.input.command)
  const output =
    part.state.status === "completed"
      ? part.state.output
      : part.state.status === "error"
        ? part.state.error
        : ""

  return `$ ${cmd ?? ""}${output ? `\n\n${output}` : ""}`.trim()
}

function isQuestionDismissed(part: ToolPart) {
  if (part.tool !== "question") return false
  if (part.state.status !== "error") return false
  return part.state.error.includes("dismissed this question")
}

function toolTitle(tool: string, metadata?: Record<string, unknown>) {
  switch (tool) {
    case "read":
      return "Read"
    case "list":
      return "List"
    case "glob":
      return "Glob"
    case "grep":
      return "Grep"
    case "webfetch":
      return "Webfetch"
    case "websearch":
      return webSearchProviderLabel(stringValue(metadata?.provider))
    case "task":
      return "Task"
    case "bash":
      return "Shell"
    case "edit":
      return "Edit"
    case "write":
      return "Write"
    case "apply_patch":
      return "Patch"
    case "question":
      return "Questions"
    case "skill":
      return "Skill"
    default:
      return tool
  }
}

function toolErrorSummary(part: ToolPart) {
  if (part.state.status !== "error") return "Failed"

  const cleaned = part.state.error.replace(/^Error:\s*/, "").trim()
  const prefix = `${part.tool} `
  const tail = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned
  const [head] = tail.split(": ")

  if (!head || head === tail) return "Failed"
  return titleCase(head.trim())
}

function toolErrorBody(part: ToolPart) {
  if (part.state.status !== "error") return ""

  const cleaned = part.state.error.replace(/^Error:\s*/, "").trim()
  const prefix = `${part.tool} `
  const tail = cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned
  const parts = tail.split(": ")

  if (parts.length <= 1) return cleaned
  return parts.slice(1).join(": ").trim() || cleaned
}

function taskHref(agentName: string, path: string, part: ToolPart) {
  if (part.tool !== "task") return undefined
  const metadata = toolMetadata(part)
  const sessionID = stringValue(metadata?.sessionId)

  if (!sessionID) return undefined

  const match = path.match(/^\/agents\/([^/]+)\/([^/]+|new)$/)
  if (!match) return `/agents/${agentName}/${sessionID}`
  return `/agents/${match[1]}/${sessionID}`
}

function toolIcon(tool: string) {
  switch (tool) {
    case "read":
      return SearchIcon
    case "list":
      return ListIcon
    case "glob":
    case "grep":
      return FolderSearch2Icon
    case "webfetch":
    case "websearch":
      return GlobeIcon
    case "bash":
      return TerminalSquareIcon
    case "edit":
    case "write":
    case "apply_patch":
      return WrenchIcon
    case "question":
      return MessageSquareQuoteIcon
    case "skill":
      return BrainIcon
    case "task":
      return ExternalLinkIcon
    default:
      return FolderIcon
  }
}

function TriggerLine({ action, arg, href, pending, title, tone = "neutral" }: TriggerProps) {
  const Icon = pending ? Spinner : null

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 leading-tight">
          <div className={cn("shrink-0 font-medium text-sm", toneClass(tone))}>{title}</div>
          {arg ? (
            href ? (
              <Link
                className="truncate font-mono text-muted-foreground text-sm underline-offset-2 hover:underline"
                href={href}
                onClick={(event) => event.stopPropagation()}
                target="_blank"
              >
                {arg}
              </Link>
            ) : (
              <div className="truncate font-mono text-muted-foreground text-sm">{arg}</div>
            )
          ) : null}
          {pending && Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
          {action ? <div className="ml-auto shrink-0">{action}</div> : null}
        </div>
      </div>
    </div>
  )
}

function ToolCard({
  children,
  defaultOpen = false,
  hideDetails = false,
  ...trigger
}: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const hasDetails = !hideDetails && Boolean(children)

  if (!hasDetails) {
    return <TriggerLine {...trigger} />
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="flex items-center">
        <CollapsibleTrigger asChild>
          <button className="min-w-0 flex-1 rounded-sm text-left" type="button">
            <div className="flex items-center">
              <div className="min-w-0 flex-1">
                <TriggerLine {...{ ...trigger, action: undefined }} />
              </div>
              <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                {open ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
              </span>
            </div>
          </button>
        </CollapsibleTrigger>
        {trigger.action ? <div className="ml-2 shrink-0">{trigger.action}</div> : null}
      </div>
      <CollapsibleContent>
        <div className="space-y-1 border-l-2 border-muted-foreground/20 pt-1 pl-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolDetailText({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-96 overflow-auto text-sm leading-5">
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function ToolDescription({ children }: { children: React.ReactNode }) {
  if (!children) return null

  return <div className="text-muted-foreground text-sm whitespace-pre-wrap">{children}</div>
}

function ToolCode({ code, language = "markdown" }: { code: string; language?: BundledLanguage }) {
  return (
    <div className="[&_pre]:p-0 [&_pre]:text-xs" data-language={language}>
      <CodeBlockContent code={code} language={language} showLineNumbers={code.includes("\n")} />
    </div>
  )
}

function LoadedFiles({ files }: { files: string[] }) {
  if (files.length === 0) return null

  return (
    <div className="space-y-1 text-muted-foreground text-sm">
      {files.map((path) => (
        <div className="flex items-center gap-1.5" key={path}>
          <ChevronRightIcon className="size-3 shrink-0" />
          <span className="truncate">{path}</span>
        </div>
      ))}
    </div>
  )
}

function Diagnostics({ items }: { items: Diagnostic[] }) {
  if (items.length === 0) return null

  return (
    <div className="space-y-1">
      {items.slice(0, 3).map((item, index) => (
        <div className="flex gap-1.5 text-chat-error text-sm" key={`${item.message}-${index}`}>
          <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <div className="min-w-0">
            <span className="font-mono text-xs">
              [{item.range.start.line + 1}:{item.range.start.character + 1}]
            </span>{" "}
            <span>{item.message}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function GenericTool({ part }: ToolProps) {
  const input = part.state.input
  const arg =
    truncate(stringValue(input.name)) ??
    truncate(stringValue(input.filePath) ? fileName(String(input.filePath)) : undefined) ??
    truncate(stringValue(input.pattern)) ??
    truncate(stringValue(input.query)) ??
    truncate(stringValue(input.url)) ??
    truncate(stringValue(input.path))

  const extraArgs = Object.entries(input)
    .filter(([key]) => !genericToolPrimaryKeys.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [`${key}=${value}`]
      }
      return []
    })
    .slice(0, 3)

  return (
    <ToolCard
      arg={arg ?? truncate(extraArgs[0])}
      title={part.tool}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{stringValue(input.description)}</ToolDescription>
    </ToolCard>
  )
}

function ReadTool({ part }: ToolProps) {
  const offset = numberValue(part.state.input.offset)
  const limit = numberValue(part.state.input.limit)
  const metadata = toolMetadata(part)
  const arg =
    truncate(
      stringValue(part.state.input.filePath)
        ? fileName(String(part.state.input.filePath))
        : undefined
    ) ??
    truncate(
      offset !== undefined || limit !== undefined
        ? [
            offset !== undefined ? `offset=${offset}` : undefined,
            limit !== undefined ? `limit=${limit}` : undefined,
          ]
            .filter(Boolean)
            .join(" ")
        : undefined
    )

  return (
    <div className="space-y-1">
      <ToolCard arg={arg} title="Read" tone={toolStateTone(part.state.status)} />
      <LoadedFiles files={loadedFiles(metadata?.loaded)} />
    </div>
  )
}

function MarkdownTool({
  arg,
  description,
  part,
  title,
}: {
  arg?: string
  description?: string
  part: ToolPart
  title: string
}) {
  const output = part.state.status === "completed" ? part.state.output : undefined

  return (
    <ToolCard
      arg={truncate(arg)}
      hideDetails={!output}
      title={title}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{description}</ToolDescription>
      {output ? (
        <ToolDetailText>
          <MessageResponse plainCodeBlocks>{output}</MessageResponse>
        </ToolDetailText>
      ) : null}
    </ToolCard>
  )
}

function WebfetchTool({ part }: ToolProps) {
  const url = stringValue(part.state.input.url)

  return (
    <ToolCard
      action={url ? <ExternalLinkIcon className="size-3.5 text-muted-foreground" /> : null}
      hideDetails
      href={url}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={truncate(url)}
      title="Webfetch"
      tone={toolStateTone(part.state.status)}
    />
  )
}

function WebsearchTool({ part }: ToolProps) {
  const query = stringValue(part.state.input.query)
  const metadata = toolMetadata(part)
  const output = part.state.status === "completed" ? part.state.output : undefined
  const links = urls(output)

  return (
    <ToolCard
      hideDetails={links.length === 0}
      arg={truncate(query)}
      title={toolTitle(part.tool, metadata)}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{query}</ToolDescription>
      <div className="space-y-1">
        {links.map((url) => (
          <Link
            className="block truncate text-primary text-sm underline-offset-2 hover:underline"
            href={url}
            key={url}
            target="_blank"
          >
            {url}
          </Link>
        ))}
      </div>
    </ToolCard>
  )
}

function TaskTool({ agentName, part }: ToolProps) {
  const pathname = usePathname()
  const href = taskHref(agentName, pathname, part)
  const type = stringValue(part.state.input.subagent_type)
  const description = stringValue(part.state.input.description)
  const sessionId = stringValue(toolMetadata(part)?.sessionId)

  return (
    <ToolCard
      hideDetails={!description && !sessionId}
      href={href}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={truncate(type ? titleCase(type) : sessionId)}
      title={type ? `${titleCase(type)} Agent` : "Agent"}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{description ?? sessionId}</ToolDescription>
    </ToolCard>
  )
}

function BashTool({ part }: ToolProps) {
  const transcript = shellTranscript(part)
  const description = stringValue(part.state.input.description)

  return (
    <ToolCard
      hideDetails={!transcript}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={truncate(stringValue(part.state.input.command))}
      title="Shell"
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{description}</ToolDescription>
      {transcript ? (
        <ToolDetailText>
          <ToolCode code={transcript} language="bash" />
        </ToolDetailText>
      ) : null}
    </ToolCard>
  )
}

function EditTool({ part }: ToolProps) {
  const metadata = toolMetadata(part)
  const inputPath = stringValue(part.state.input.filePath)
  const body = stringValue(
    metadata?.filediff && record(metadata.filediff) ? metadata.filediff.after : undefined
  )
  const diagnostics = diagnosticsByPath(metadata?.diagnostics, inputPath)

  return (
    <ToolCard
      hideDetails={!body && diagnostics.length === 0}
      arg={truncate(inputPath ? fileName(inputPath) : undefined)}
      title="Edit"
      tone={toolStateTone(part.state.status)}
    >
      {body ? (
        <ToolDetailText>
          <ToolCode code={body} />
        </ToolDetailText>
      ) : null}
      <Diagnostics items={diagnostics} />
    </ToolCard>
  )
}

function WriteTool({ part }: ToolProps) {
  const inputPath = stringValue(part.state.input.filePath)
  const content = stringValue(part.state.input.content)
  const metadata = toolMetadata(part)
  const diagnostics = diagnosticsByPath(metadata?.diagnostics, inputPath)

  return (
    <ToolCard
      hideDetails={!content && diagnostics.length === 0}
      arg={truncate(inputPath ? fileName(inputPath) : undefined)}
      title="Write"
      tone={toolStateTone(part.state.status)}
    >
      {content ? (
        <ToolDetailText>
          <ToolCode code={content} />
        </ToolDetailText>
      ) : null}
      <Diagnostics items={diagnostics} />
    </ToolCard>
  )
}

function PatchFileCard({ file }: { file: ToolFile }) {
  const diffStat =
    file.type === "add"
      ? "Created"
      : file.type === "delete"
        ? "Deleted"
        : file.type === "move"
          ? "Moved"
          : `+${file.additions} -${file.deletions}`
  const body = file.patch ?? file.after ?? file.before ?? ""

  return (
    <AccordionItem value={file.relativePath}>
      <AccordionTrigger className="gap-3 py-1.5 hover:no-underline">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm">{fileName(file.relativePath)}</div>
          {file.relativePath.includes("/") ? (
            <div className="truncate text-muted-foreground text-xs">
              {directoryName(file.relativePath)}
            </div>
          ) : null}
        </div>
        <Badge variant="outline">{diffStat}</Badge>
      </AccordionTrigger>
      <AccordionContent>
        {body ? (
          <ToolDetailText>
            <pre className="overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-xs">
              {body}
            </pre>
          </ToolDetailText>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  )
}

function ApplyPatchTool({ part }: ToolProps) {
  const metadata = toolMetadata(part)
  const files = toolFiles(metadata?.files)
  const fileCount =
    files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"}` : undefined

  return (
    <ToolCard
      hideDetails={files.length === 0}
      arg={truncate(fileCount)}
      title="Patch"
      tone={toolStateTone(part.state.status)}
    >
      <Accordion className="w-full" type="multiple">
        {files.map((file) => (
          <PatchFileCard file={file} key={`${file.relativePath}:${file.type}`} />
        ))}
      </Accordion>
    </ToolCard>
  )
}

function QuestionsTool({ part }: ToolProps) {
  const inputQuestions = questionInfos(part.state.input.questions)
  const metadata = toolMetadata(part)
  const answers = questionAnswers(metadata?.answers)
  const questionCount =
    answers.length > 0
      ? `${inputQuestions.length} answered`
      : `${inputQuestions.length} ${inputQuestions.length === 1 ? "question" : "questions"}`

  return (
    <ToolCard
      hideDetails={answers.length === 0}
      arg={truncate(questionCount)}
      title="Questions"
      tone={toolStateTone(part.state.status)}
    >
      <div className="space-y-1">
        {inputQuestions.map((question, index) => (
          <div className="space-y-0.5" key={`${question.header}-${index}`}>
            <div className="font-medium text-sm">{question.question}</div>
            <div className="text-muted-foreground text-sm">
              {(answers[index] ?? []).join(", ") || "No answer"}
            </div>
          </div>
        ))}
      </div>
    </ToolCard>
  )
}

function SkillTool({ part }: ToolProps) {
  return (
    <ToolCard
      hideDetails
      pending={part.state.status === "pending" || part.state.status === "running"}
      title={stringValue(part.state.input.name) ?? "Skill"}
      tone={toolStateTone(part.state.status)}
    />
  )
}

function TodoTool({ part }: ToolProps) {
  const metadata = toolMetadata(part)
  const items = todos(metadata?.todos ?? part.state.input.todos)
  const completed = items.filter((item) => item.status === "completed").length

  return (
    <ToolCard
      hideDetails={items.length === 0}
      arg={items.length > 0 ? `${completed}/${items.length}` : undefined}
      title="Todos"
      tone={toolStateTone(part.state.status)}
    >
      <div className="space-y-1">
        {items.map((item, index) => (
          <div className="flex items-start gap-2 text-sm" key={`${item.content}-${index}`}>
            <span
              className={cn("mt-0.5 size-2.5 rounded-full border", {
                "border-chat-active bg-chat-active": item.status === "completed",
                "border-chat-neutral": item.status !== "completed",
              })}
            />
            <span
              className={cn(
                item.status === "completed" ? "text-muted-foreground line-through" : ""
              )}
            >
              {item.content}
            </span>
          </div>
        ))}
      </div>
    </ToolCard>
  )
}

function ToolErrorCard({ part }: ToolProps) {
  const summary = toolErrorSummary(part)
  const body = toolErrorBody(part)
  const title = toolTitle(part.tool, toolMetadata(part))

  return (
    <ToolCard hideDetails={!body} arg={summary} title={title} tone="error">
      {body ? <ToolDetailText>{body}</ToolDetailText> : null}
    </ToolCard>
  )
}

function ContextToolGroup({ parts }: { parts: ToolPart[] }) {
  const [open, setOpen] = useState(false)
  const counts = useMemo(() => {
    return {
      list: parts.filter((part) => part.tool === "list").length,
      read: parts.filter((part) => part.tool === "read").length,
      search: parts.filter((part) => part.tool === "glob" || part.tool === "grep").length,
    }
  }, [parts])
  const pending = parts.some(
    (part) => part.state.status === "pending" || part.state.status === "running"
  )
  const summary = [
    counts.read ? `${counts.read} read` : undefined,
    counts.search ? `${counts.search} search` : undefined,
    counts.list ? `${counts.list} list` : undefined,
  ]
    .filter(Boolean)
    .join(", ")

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <button className="min-h-8 w-full py-1 text-left" type="button">
          <div className="flex items-center">
            <div className="min-w-0 flex-1">
              <TriggerLine
                arg={summary}
                pending={pending}
                title={pending ? "Gathering Context" : "Gathered Context"}
                tone={pending ? "active" : "neutral"}
              />
            </div>
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              {open ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </span>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1 border-chat-neutral/20 border-l pl-3">
          {parts.map((part) => {
            const Icon = toolIcon(part.tool)
            const title = toolTitle(part.tool)
            const arg =
              part.tool === "read"
                ? stringValue(part.state.input.filePath)
                  ? fileName(String(part.state.input.filePath))
                  : undefined
                : part.tool === "list"
                  ? directoryName(stringValue(part.state.input.path) ?? "/")
                  : part.tool === "glob"
                    ? directoryName(stringValue(part.state.input.path) ?? "/")
                    : part.tool === "grep"
                      ? directoryName(stringValue(part.state.input.path) ?? "/")
                      : undefined

            return (
              <div className="flex items-center gap-2 text-sm" key={part.id}>
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <div
                      className={cn(
                        "shrink-0 font-medium text-sm",
                        toneClass(toolStateTone(part.state.status))
                      )}
                    >
                      {title}
                    </div>
                    {arg ? (
                      <div className="truncate font-mono text-muted-foreground text-sm">
                        {truncate(arg)}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolView({ agentName, part }: ToolProps) {
  if (isQuestionDismissed(part)) {
    return <div className="text-muted-foreground text-sm">Question dismissed</div>
  }

  if (part.state.status === "error") {
    return <ToolErrorCard agentName={agentName} part={part} />
  }

  switch (part.tool) {
    case "read":
      return <ReadTool agentName={agentName} part={part} />
    case "list":
      return (
        <MarkdownTool
          arg={directoryName(stringValue(part.state.input.path) ?? "/")}
          part={part}
          title="List"
        />
      )
    case "glob":
      return (
        <MarkdownTool
          arg={stringValue(part.state.input.pattern) ?? stringValue(part.state.input.path)}
          part={part}
          title="Glob"
        />
      )
    case "grep":
      return (
        <MarkdownTool
          arg={stringValue(part.state.input.pattern) ?? stringValue(part.state.input.include)}
          part={part}
          title="Grep"
        />
      )
    case "webfetch":
      return <WebfetchTool agentName={agentName} part={part} />
    case "websearch":
      return <WebsearchTool agentName={agentName} part={part} />
    case "task":
      return <TaskTool agentName={agentName} part={part} />
    case "bash":
      return <BashTool agentName={agentName} part={part} />
    case "edit":
      return <EditTool agentName={agentName} part={part} />
    case "write":
      return <WriteTool agentName={agentName} part={part} />
    case "apply_patch":
      return <ApplyPatchTool agentName={agentName} part={part} />
    case "question":
      return <QuestionsTool agentName={agentName} part={part} />
    case "skill":
      return <SkillTool agentName={agentName} part={part} />
    case "todowrite":
      return <TodoTool agentName={agentName} part={part} />
    default:
      return <GenericTool agentName={agentName} part={part} />
  }
}

export function toolEntries(parts: ToolPart[]) {
  return groupTools(parts)
}

export function ToolEntries({ agentName, entry }: { agentName: string; entry: ToolEntry }) {
  if (entry.type === "context") {
    return <ContextToolGroup parts={entry.parts} />
  }

  return <ToolView agentName={agentName} part={entry.part} />
}
