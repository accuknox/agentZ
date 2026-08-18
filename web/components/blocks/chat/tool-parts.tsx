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
import type { ToolEntry } from "@/components/blocks/chat/timeline"
import { cn } from "@/lib/utils"
import type { ToolPart } from "@opencode-ai/sdk/v2"
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
import type { BundledLanguage } from "shiki"
import { useState } from "react"
import * as z from "zod"

type ToolProps = {
  agentName: string
  part: ToolPart
}

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

const nonEmptyStringSchema = z.string().min(1)
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional().catch(undefined)
const numberSchema = z.number()
const displayPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()])
const loadedFilesSchema = z.array(z.string()).catch([])
const toolFileSchema = z
  .object({
    additions: z.number().catch(0),
    deletions: z.number().catch(0),
    filePath: nonEmptyStringSchema,
    movePath: optionalNonEmptyStringSchema,
    patch: optionalNonEmptyStringSchema,
    relativePath: optionalNonEmptyStringSchema,
    type: z.enum(["add", "delete", "move", "update"]),
  })
  .transform(({ filePath, relativePath, ...file }) => ({
    ...file,
    filePath,
    relativePath: relativePath ?? filePath,
  }))
const toolFilesSchema = z.array(toolFileSchema).catch([])
const diagnosticSchema = z.object({
  message: z.string(),
  range: z.object({
    end: z.object({ character: z.number(), line: z.number() }),
    start: z.object({ character: z.number(), line: z.number() }),
  }),
  severity: z.number().optional(),
})
const diagnosticsByFileSchema = z.record(z.string(), z.array(diagnosticSchema)).catch({})
const questionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
})
const questionInfoSchema = z.object({
  header: z.string(),
  multiple: z.boolean().optional(),
  options: z.array(questionOptionSchema),
  question: z.string(),
})
const questionInfosSchema = z.array(questionInfoSchema).catch([])
const questionAnswersSchema = z.array(z.array(z.string())).catch([])
const todosSchema = z
  .array(
    z.object({
      content: z.string(),
      priority: z.string(),
      status: z.string(),
    })
  )
  .catch([])

function nonEmptyString(value: unknown) {
  const parsed = nonEmptyStringSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function numberValue(value: unknown) {
  const parsed = numberSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function baseName(path: string) {
  const displayPath = path.replace(/\\/g, "/")
  const index = displayPath.lastIndexOf("/")
  return index >= 0 ? displayPath.slice(index + 1) : displayPath
}

function directoryPath(path: string) {
  const displayPath = path.replace(/\\/g, "/")
  const index = displayPath.lastIndexOf("/")
  return index > 0 ? displayPath.slice(0, index) : "/"
}

function capitalize(value: string) {
  return value[0] ? value[0].toUpperCase() + value.slice(1) : value
}

function shortLabel(value: string | undefined, max = 56) {
  if (!value) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}...`
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
  if (!("metadata" in part.state)) {
    return part.metadata
  }

  return part.state.metadata
}

function toneClass(tone: ToolTone) {
  switch (tone) {
    case "active":
      return "text-primary"
    case "error":
      return "text-destructive"
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

function diagnosticsByPath(value: unknown, filePath: string | undefined) {
  if (!filePath) return []
  // Only errors (severity 1) surface, matching opencode's parseDiagnostics.
  return (diagnosticsByFileSchema.parse(value)[filePath] ?? []).filter((d) => d.severity === 1)
}

function shellTranscript(part: ToolPart) {
  const cmd = nonEmptyString(part.state.input.command)
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
      return webSearchProviderLabel(nonEmptyString(metadata?.provider))
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
  return capitalize(head.trim())
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
          <div className={cn("shrink-0 text-sm font-medium", toneClass(tone))}>{title}</div>
          {arg ? (
            href ? (
              <a
                className="text-muted-foreground truncate font-mono text-sm underline-offset-2 hover:underline"
                href={href}
                onClick={(event) => event.stopPropagation()}
                rel="noreferrer"
                target="_blank"
              >
                {arg}
              </a>
            ) : (
              <div className="text-muted-foreground truncate font-mono text-sm">{arg}</div>
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
              <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
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
        <div className="border-muted-foreground/20 space-y-1 border-l-2 pt-1 pl-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolDetailText({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-96 max-w-full overflow-auto text-sm leading-5">
      <div className="max-w-full min-w-0 wrap-break-word">{children}</div>
    </div>
  )
}

function ToolDescription({ children }: { children: React.ReactNode }) {
  if (!children) return null

  return (
    <div className="text-muted-foreground text-sm wrap-break-word whitespace-pre-wrap">
      {children}
    </div>
  )
}

function ToolCode({ code, language = "markdown" }: { code: string; language?: BundledLanguage }) {
  return (
    <div className="max-w-full min-w-0 [&_pre]:p-0 [&_pre]:text-xs" data-language={language}>
      <CodeBlockContent code={code} language={language} showLineNumbers={code.includes("\n")} />
    </div>
  )
}

function LoadedFiles({ files }: { files: string[] }) {
  if (files.length === 0) return null

  return (
    <div className="text-muted-foreground space-y-1 text-sm">
      {files.map((path) => (
        <div className="flex min-w-0 items-center gap-1.5" key={path}>
          <ChevronRightIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{path}</span>
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
        <div className="text-destructive flex gap-1.5 text-sm" key={`${item.message}-${index}`}>
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
  const inputFilePath = nonEmptyString(input.filePath)
  const arg =
    shortLabel(nonEmptyString(input.name)) ??
    shortLabel(inputFilePath ? baseName(inputFilePath) : undefined) ??
    shortLabel(nonEmptyString(input.pattern)) ??
    shortLabel(nonEmptyString(input.query)) ??
    shortLabel(nonEmptyString(input.url)) ??
    shortLabel(nonEmptyString(input.path))

  const extraArgs = Object.entries(input)
    .filter(([key]) => !genericToolPrimaryKeys.has(key))
    .flatMap(([key, value]) => {
      const parsed = displayPrimitiveSchema.safeParse(value)
      return parsed.success ? [`${key}=${parsed.data}`] : []
    })
    .slice(0, 3)

  return (
    <ToolCard
      arg={arg ?? shortLabel(extraArgs[0])}
      title={part.tool}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{nonEmptyString(input.description)}</ToolDescription>
    </ToolCard>
  )
}

function ReadTool({ part }: ToolProps) {
  const offset = numberValue(part.state.input.offset)
  const limit = numberValue(part.state.input.limit)
  const metadata = toolMetadata(part)
  const inputFilePath = nonEmptyString(part.state.input.filePath)
  const arg =
    shortLabel(inputFilePath ? baseName(inputFilePath) : undefined) ??
    shortLabel(
      offset !== undefined || limit !== undefined
        ? [
            offset !== undefined ? `offset=${offset}` : undefined,
            limit !== undefined ? `limit=${limit}` : undefined,
          ]
            .filter(Boolean)
            .join(" ")
        : undefined
    )

  // opencode hides the loaded-files list once the turn is compacted.
  const loaded =
    part.state.status === "completed" && !part.state.time.compacted
      ? loadedFilesSchema.parse(metadata?.loaded)
      : []

  return (
    <div className="space-y-1">
      <ToolCard arg={arg} title="Read" tone={toolStateTone(part.state.status)} />
      <LoadedFiles files={loaded} />
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
      arg={shortLabel(arg)}
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
  const url = nonEmptyString(part.state.input.url)

  return (
    <ToolCard
      action={url ? <ExternalLinkIcon className="text-muted-foreground size-3.5" /> : null}
      hideDetails
      href={url}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={shortLabel(url)}
      title="Webfetch"
      tone={toolStateTone(part.state.status)}
    />
  )
}

function WebsearchTool({ part }: ToolProps) {
  const query = nonEmptyString(part.state.input.query)
  const metadata = toolMetadata(part)
  const output = part.state.status === "completed" ? part.state.output : undefined
  const links = urls(output)

  return (
    <ToolCard
      hideDetails={links.length === 0}
      arg={shortLabel(query)}
      title={toolTitle(part.tool, metadata)}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{query}</ToolDescription>
      <div className="space-y-1">
        {links.map((url) => (
          <a
            className="text-primary block truncate text-sm underline-offset-2 hover:underline"
            href={url}
            key={url}
            rel="noreferrer"
            target="_blank"
          >
            {url}
          </a>
        ))}
      </div>
    </ToolCard>
  )
}

function TaskTool({ agentName, part, workspacePath }: ToolProps & { workspacePath: string }) {
  const type = nonEmptyString(part.state.input.subagent_type)
  const description = nonEmptyString(part.state.input.description)
  const sessionId = nonEmptyString(toolMetadata(part)?.sessionId)
  const href = sessionId
    ? `${workspacePath}/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}`
    : undefined

  return (
    <ToolCard
      hideDetails={!description && !sessionId}
      href={href}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={shortLabel(type ? capitalize(type) : sessionId)}
      title={type ? `${capitalize(type)} Agent` : "Agent"}
      tone={toolStateTone(part.state.status)}
    >
      <ToolDescription>{description ?? sessionId}</ToolDescription>
    </ToolCard>
  )
}

function BashTool({ part }: ToolProps) {
  const transcript = shellTranscript(part)
  const description = nonEmptyString(part.state.input.description)

  return (
    <ToolCard
      hideDetails={!transcript}
      pending={part.state.status === "pending" || part.state.status === "running"}
      arg={shortLabel(nonEmptyString(part.state.input.command))}
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
  const inputPath = nonEmptyString(part.state.input.filePath)
  const body = nonEmptyString(metadata?.diff)
  const diagnostics = diagnosticsByPath(metadata?.diagnostics, inputPath)

  return (
    <ToolCard
      hideDetails={!body && diagnostics.length === 0}
      arg={shortLabel(inputPath ? baseName(inputPath) : undefined)}
      title="Edit"
      tone={toolStateTone(part.state.status)}
    >
      {body ? (
        <ToolDetailText>
          <ToolCode code={body} language="diff" />
        </ToolDetailText>
      ) : null}
      <Diagnostics items={diagnostics} />
    </ToolCard>
  )
}

function WriteTool({ part }: ToolProps) {
  const inputPath = nonEmptyString(part.state.input.filePath)
  const content = nonEmptyString(part.state.input.content)
  const metadata = toolMetadata(part)
  const diagnostics = diagnosticsByPath(metadata?.diagnostics, inputPath)

  return (
    <ToolCard
      hideDetails={!content && diagnostics.length === 0}
      arg={shortLabel(inputPath ? baseName(inputPath) : undefined)}
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
  const body = file.patch ?? ""

  return (
    <AccordionItem value={file.relativePath}>
      <AccordionTrigger className="gap-3 py-1.5 hover:no-underline">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{baseName(file.relativePath)}</div>
          {file.relativePath.includes("/") ? (
            <div className="text-muted-foreground truncate text-xs">
              {directoryPath(file.relativePath)}
            </div>
          ) : null}
        </div>
        <Badge variant="outline">{diffStat}</Badge>
      </AccordionTrigger>
      <AccordionContent>
        {body ? (
          <ToolDetailText>
            <pre className="max-w-full overflow-auto font-mono text-xs wrap-break-word whitespace-pre-wrap">
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
  const files = toolFilesSchema.parse(metadata?.files)
  const fileCount =
    files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"}` : undefined

  return (
    <ToolCard
      hideDetails={files.length === 0}
      arg={shortLabel(fileCount)}
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
  const inputQuestions = questionInfosSchema.parse(part.state.input.questions)
  const metadata = toolMetadata(part)
  const answers = questionAnswersSchema.parse(metadata?.answers)
  const questionCount =
    answers.length > 0
      ? `${inputQuestions.length} answered`
      : `${inputQuestions.length} ${inputQuestions.length === 1 ? "question" : "questions"}`

  return (
    <ToolCard
      hideDetails={answers.length === 0}
      arg={shortLabel(questionCount)}
      title="Questions"
      tone={toolStateTone(part.state.status)}
    >
      <div className="space-y-1">
        {inputQuestions.map((question, index) => (
          <div className="space-y-0.5" key={`${question.header}-${index}`}>
            <div className="text-sm font-medium wrap-break-word">{question.question}</div>
            <div className="text-muted-foreground text-sm wrap-break-word">
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
      title={nonEmptyString(part.state.input.name) ?? "Skill"}
      tone={toolStateTone(part.state.status)}
    />
  )
}

function TodoTool({ part }: ToolProps) {
  const metadata = toolMetadata(part)
  const items = todosSchema.parse(metadata?.todos ?? part.state.input.todos)
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
                "border-primary bg-primary": item.status === "completed",
                "border-muted-foreground": item.status !== "completed",
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
  let list = 0
  let read = 0
  let search = 0
  for (const part of parts) {
    switch (part.tool) {
      case "list":
        list += 1
        break
      case "read":
        read += 1
        break
      case "glob":
      case "grep":
        search += 1
        break
    }
  }
  const pending = parts.some(
    (part) => part.state.status === "pending" || part.state.status === "running"
  )
  const summary = [
    read ? `${read} read` : undefined,
    search ? `${search} search` : undefined,
    list ? `${list} list` : undefined,
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
            <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
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
        <div className="border-muted-foreground/20 flex flex-col gap-1 border-l pl-3">
          {parts.map((part) => {
            const Icon = toolIcon(part.tool)
            const title = toolTitle(part.tool)
            const inputFilePath = nonEmptyString(part.state.input.filePath)
            const arg =
              part.tool === "read"
                ? inputFilePath
                  ? baseName(inputFilePath)
                  : undefined
                : part.tool === "list"
                  ? directoryPath(nonEmptyString(part.state.input.path) ?? "/")
                  : part.tool === "glob"
                    ? directoryPath(nonEmptyString(part.state.input.path) ?? "/")
                    : part.tool === "grep"
                      ? directoryPath(nonEmptyString(part.state.input.path) ?? "/")
                      : undefined

            return (
              <div className="flex min-w-0 items-center gap-2 text-sm" key={part.id}>
                <Icon className="text-muted-foreground size-3 shrink-0" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <div
                      className={cn(
                        "shrink-0 text-sm font-medium",
                        toneClass(toolStateTone(part.state.status))
                      )}
                    >
                      {title}
                    </div>
                    {arg ? (
                      <div className="text-muted-foreground min-w-0 truncate font-mono text-sm">
                        {shortLabel(arg)}
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

function ToolView({ agentName, part, workspacePath }: ToolProps & { workspacePath: string }) {
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
          arg={directoryPath(nonEmptyString(part.state.input.path) ?? "/")}
          part={part}
          title="List"
        />
      )
    case "glob":
      return (
        <MarkdownTool
          arg={nonEmptyString(part.state.input.pattern) ?? nonEmptyString(part.state.input.path)}
          part={part}
          title="Glob"
        />
      )
    case "grep":
      return (
        <MarkdownTool
          arg={nonEmptyString(part.state.input.pattern) ?? nonEmptyString(part.state.input.include)}
          part={part}
          title="Grep"
        />
      )
    case "webfetch":
      return <WebfetchTool agentName={agentName} part={part} />
    case "websearch":
      return <WebsearchTool agentName={agentName} part={part} />
    case "task":
      return <TaskTool agentName={agentName} part={part} workspacePath={workspacePath} />
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

export function ToolEntries({
  agentName,
  entry,
  workspacePath,
}: {
  agentName: string
  entry: ToolEntry
  workspacePath: string
}) {
  if (entry.type === "context") {
    return <ContextToolGroup parts={entry.parts} />
  }

  return <ToolView agentName={agentName} part={entry.part} workspacePath={workspacePath} />
}
