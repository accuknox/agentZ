"use client"

import type { ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2"
import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { queryOptions, useQueryClient } from "@tanstack/react-query"
import { useMemo, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import {
  BrainIcon,
  ChevronRightIcon,
  FileTextIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  CircleAlertIcon,
} from "lucide-react"
import { z } from "zod"
import { MessageResponse } from "@/components/ai-elements/message"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"

type WorkPart = ReasoningPart | ToolPart

const toolText = z.string()
const tools: Record<
  string,
  { icon: typeof WrenchIcon; action: string; past: string; noun: string; field: string }
> = {
  bash: { icon: TerminalIcon, action: "command", past: "Ran", noun: "command", field: "command" },
  read: { icon: FileTextIcon, action: "read", past: "Read", noun: "file", field: "filePath" },
  edit: { icon: PencilIcon, action: "edit", past: "Changed", noun: "file", field: "filePath" },
  write: { icon: PencilIcon, action: "edit", past: "Changed", noun: "file", field: "filePath" },
  apply_patch: {
    icon: PencilIcon,
    action: "edit",
    past: "Changed",
    noun: "patch",
    field: "patchText",
  },
  grep: { icon: SearchIcon, action: "search", past: "Searched", noun: "pattern", field: "pattern" },
  glob: { icon: SearchIcon, action: "search", past: "Searched", noun: "pattern", field: "pattern" },
  websearch: {
    icon: SearchIcon,
    action: "search",
    past: "Searched",
    noun: "query",
    field: "query",
  },
  webfetch: { icon: SearchIcon, action: "search", past: "Fetched", noun: "page", field: "url" },
}

function toolPresentation(part: ToolPart) {
  // Native tools own these input field contracts. Custom tools keep their title.
  const known = tools[part.tool]
  const target = known ? toolText.safeParse(part.state.input[known.field]) : undefined
  const title =
    part.state.status === "pending" || part.state.status === "error"
      ? part.tool
      : (part.state.title ?? part.tool)
  return {
    icon: known?.icon ?? WrenchIcon,
    action: known?.action ?? "other",
    past: known?.past ?? "Used",
    noun: known?.noun ?? "tool",
    label: target?.success && part.tool !== "apply_patch" ? `${known?.past} ${target.data}` : title,
  }
}

/* Work-log layout and disclosure behavior adapted from T3 Code, MIT License.
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
export function WorkGroup({
  parts,
  active,
  scope,
  onAgentFileOpen,
}: {
  parts: WorkPart[]
  active: boolean
  scope: string
  onAgentFileOpen: (path: string, name: string) => void
}) {
  const queryClient = useQueryClient()
  const listRef = useRef<LegendListRef>(null)
  const [expandedHeight, setExpandedHeight] = useState(0)
  const [followingTools, setFollowingTools] = useState(true)
  const anchor = parts[0]?.id
  const key = useMemo(() => ["chatActivityView", scope, anchor], [scope, anchor])
  const single = parts.length === 1 ? parts[0] : undefined
  const [expanded, setExpanded] = useState(() => queryClient.getQueryData<boolean>(key) ?? false)
  const tools = parts.filter((part): part is ToolPart => part.type === "tool")
  const thought = parts.findLast((part) => part.type === "reasoning" && part.text.trim())
  const running = active
    ? parts.findLast((part) =>
        part.type === "tool"
          ? part.state.status === "pending" || part.state.status === "running"
          : !part.time.end
      )
    : undefined
  const latest = running ?? parts.at(-1)
  const failed = tools.some((part) => part.state.status === "error")
  const presentations = tools.map(toolPresentation)
  const first = presentations[0]
  const same =
    first && presentations.every((item) => item.action === first.action && item.noun === first.noun)
  let label = "Thought"
  if (tools.length)
    label = same
      ? `${first.past} ${tools.length} ${first.noun}${tools.length === 1 ? "" : "s"}`
      : `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
  if (single?.type === "tool") label = toolPresentation(single).label
  if (active && latest)
    label = latest.type === "reasoning" ? "Thinking" : toolPresentation(latest).label
  const Icon = latest?.type === "tool" ? toolPresentation(latest).icon : BrainIcon
  const scrollRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const scrollKey = useMemo(() => [...key, "scroll"], [key])
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !expanded) return
    node.scrollTop = queryClient.getQueryData<number>(scrollKey) ?? node.scrollHeight
    follow.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 4
  }, [expanded, queryClient, scrollKey])
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (active && follow.current && node) node.scrollTop = node.scrollHeight
  }, [active, parts])
  const toggle = () => {
    setExpanded(!expanded)
    queryClient.setQueryData(key, !expanded)
    // The same entry can acquire siblings while its details are open.
    if (single?.type === "tool") {
      const entry = queryOptions({ queryKey: ["chatActivityEntry", scope, single.id] })
      queryClient.setQueryData(entry.queryKey, !expanded)
    }
  }
  let content: ReactNode = null
  if (expanded) {
    if (single?.type === "tool")
      content = (
        <WorkDetails
          part={single}
          active={active}
          scope={scope}
          onAgentFileOpen={onAgentFileOpen}
        />
      )
    else if (tools.length === 0)
      content = (
        <div
          ref={scrollRef}
          role="region"
          aria-label="Reasoning"
          tabIndex={0}
          onScroll={(e) => {
            const node = e.currentTarget
            follow.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 4
            queryClient.setQueryData(scrollKey, node.scrollTop)
          }}
          className="ms-6 flex max-h-96 flex-col gap-3 overflow-auto py-1"
        >
          {parts.map((part) =>
            part.type === "reasoning" ? (
              <MessageResponse key={part.id} onAgentFileOpen={onAgentFileOpen}>
                {part.text}
              </MessageResponse>
            ) : null
          )}
        </div>
      )
    else if (parts.length > 12)
      content = (
        <LegendList
          ref={listRef}
          aria-label="Tool activity"
          role="region"
          data={parts}
          keyExtractor={(part) => part.id}
          estimatedItemSize={24}
          style={{ height: `calc(min(18rem, 50dvh) + ${expandedHeight}px)` }}
          initialScrollOffset={queryClient.getQueryData<number>(scrollKey)}
          maintainVisibleContentPosition
          maintainScrollAtEnd={
            active && followingTools ? { animated: false, on: { dataChange: true } } : false
          }
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
            setFollowingTools(contentSize.height - layoutMeasurement.height - contentOffset.y <= 4)
            queryClient.setQueryData(scrollKey, contentOffset.y)
          }}
          onItemSizeChanged={() => {
            const sizes = listRef.current?.getState().sizes
            let extra = 0
            for (const part of parts) extra += Math.max(0, (sizes?.get(part.id) ?? 24) - 24)
            setExpandedHeight(extra)
          }}
          recycleItems={false}
          renderItem={({ item }) => (
            <WorkEntry
              part={item}
              active={active}
              scope={scope}
              onAgentFileOpen={onAgentFileOpen}
            />
          )}
        />
      )
    else
      content = (
        <div>
          {parts.map((part) => (
            <WorkEntry
              key={part.id}
              part={part}
              active={active}
              scope={scope}
              onAgentFileOpen={onAgentFileOpen}
            />
          ))}
        </div>
      )
  }
  return (
    <section aria-label="Work log" className="py-1 text-sm">
      {!expanded && active && thought?.type === "reasoning" ? (
        <div className="mb-0.5 flex gap-1.5 text-muted-foreground">
          <BrainIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
          <p className="line-clamp-4">
            {thought.text
              .trim()
              .split(/\n\s*\n/)
              .at(-1)}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {active && !failed ? <Shimmer>{label}</Shimmer> : label}
        </span>
        {failed ? (
          <CircleAlertIcon aria-label="Tool call failed" className="size-3.5 text-destructive" />
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90"
          )}
        />
      </button>
      {content}
    </section>
  )
}

type WorkEntryProps = {
  part: WorkPart
  active: boolean
  scope: string
  onAgentFileOpen: (path: string, name: string) => void
}

function WorkEntry({ part, active, scope, onAgentFileOpen }: WorkEntryProps) {
  const queryClient = useQueryClient()
  const key = ["chatActivityEntry", scope, part.id]
  const [expanded, setExpanded] = useState(() => queryClient.getQueryData<boolean>(key) ?? false)
  const running =
    active &&
    (part.type === "reasoning"
      ? !part.time.end
      : part.state.status === "running" || part.state.status === "pending")
  const failed = part.type === "tool" && part.state.status === "error"
  const presentation = part.type === "tool" ? toolPresentation(part) : undefined
  const Icon = failed ? CircleAlertIcon : (presentation?.icon ?? BrainIcon)
  let label = presentation?.label ?? (running ? "Thinking" : "Thought")
  if (!expanded && part.type === "reasoning")
    label =
      part.text
        .trim()
        .split(/\n\s*\n/)
        .at(-1) || label
  return (
    <div
      className="text-sm"
      data-tool-status={part.type === "tool" ? part.state.status : undefined}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded)
          queryClient.setQueryData(key, !expanded)
        }}
        className="flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", failed && "text-destructive")} />
        <span className="min-w-0 flex-1 truncate">
          {running ? <Shimmer>{label}</Shimmer> : label}
        </span>
        {failed ? <span className="sr-only">Tool call failed</span> : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded ? (
        <WorkDetails part={part} active={active} scope={scope} onAgentFileOpen={onAgentFileOpen} />
      ) : null}
    </div>
  )
}

function WorkDetails({ part, active, scope, onAgentFileOpen }: WorkEntryProps) {
  const queryClient = useQueryClient()
  const scrollKey = useMemo(() => ["chatActivityEntry", scope, part.id, "scroll"], [scope, part.id])
  const nodeRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const output =
    part.type === "reasoning"
      ? part.text
      : part.state.status === "completed"
        ? part.state.output
        : part.state.status === "error"
          ? part.state.error
          : ""
  const diff =
    part.type === "tool" &&
    (part.tool === "edit" || part.tool === "apply_patch") &&
    part.state.status !== "pending"
      ? toolText.safeParse(part.state.metadata?.diff)
      : undefined
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    node.scrollTop = queryClient.getQueryData<number>(scrollKey) ?? node.scrollHeight
    following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 4
  }, [queryClient, scrollKey])
  useLayoutEffect(() => {
    if (active && following.current && nodeRef.current)
      nodeRef.current.scrollTop = nodeRef.current.scrollHeight
  }, [active, output])
  return (
    <div
      ref={nodeRef}
      role="region"
      aria-label={part.type === "reasoning" ? "Reasoning" : "Tool details"}
      tabIndex={0}
      onScroll={(e) => {
        const node = e.currentTarget
        following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 4
        queryClient.setQueryData(scrollKey, node.scrollTop)
      }}
      className="ms-6 max-h-96 overflow-auto py-1 select-text"
    >
      {part.type === "reasoning" ? (
        <MessageResponse onAgentFileOpen={onAgentFileOpen}>{output}</MessageResponse>
      ) : (
        <>
          <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {part.tool === "bash"
              ? (toolText.safeParse(part.state.input.command).data ??
                JSON.stringify(part.state.input, null, 2))
              : JSON.stringify(part.state.input, null, 2)}
          </pre>
          {diff?.success ? <CodeBlock code={diff.data} language="diff" /> : null}
          {output ? (
            <pre
              className={cn(
                "mt-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground",
                part.state.status === "error" && "text-destructive"
              )}
            >
              {output}
            </pre>
          ) : null}
        </>
      )}
    </div>
  )
}
