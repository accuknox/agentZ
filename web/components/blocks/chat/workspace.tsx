"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { Globe, Files, Maximize2, Minimize2, PanelRightClose, type LucideIcon } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { useFileWorkspace } from "./file-workspace-store"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserTab } from "@/lib/gateway/client"
import { cn } from "@/lib/utils"
import { browserQueryOptions } from "./browser-query"

const Browser = dynamic(() => import("./browser").then((module) => module.Browser), { ssr: false })

const FilesWorkspace = dynamic(
  () => import("./files-workspace").then((module) => module.FilesWorkspace),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        Loading files...
      </div>
    ),
  }
)

type WorkspacePanel =
  { tab: string; mode: "closed" | "docked" } | { tab: string; mode: "floating"; tabId: string }

type WorkspaceTool = {
  id: string
  label: string
  icon: LucideIcon
  count?: number
  render: (panel: {
    visible: boolean
    expanded: boolean
    onExpand: () => void
    onClose: () => void
  }) => ReactNode
}

export function Workspace({
  agentName,
  sessionId,
  workspaceId,
  onPreviewerOpenChange,
  tools = [],
  initialTool = "files",
  footer,
}: {
  agentName: string
  sessionId?: string
  workspaceId: string
  onPreviewerOpenChange: (open: boolean) => void
  tools?: WorkspaceTool[]
  initialTool?: string
  footer?: ReactNode
}): React.JSX.Element {
  const { pendingPreview } = useFileWorkspace()
  const { data: agents = [] } = useQuery(watchAgentsQueryOptions(workspaceId))
  const browserAvailable =
    !!sessionId && (agents.find((agent) => agent.name === agentName)?.browser.enabled ?? false)
  const [panel, setPanel] = useState<WorkspacePanel>({ tab: initialTool, mode: "closed" })
  const { tab } = panel
  const docked = panel.mode === "docked"
  const browserFloating = panel.mode === "floating"
  const visibleTool = browserFloating ? "browser" : docked ? tab : undefined
  const [visited, setVisited] = useState(() => new Set<string>())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [revealed, setRevealed] = useState<{
    epoch: string
    time: number
    tab?: Pick<BrowserTab, "id" | "reveal">
  }>()
  const browser = useQuery({
    ...browserQueryOptions(workspaceId, agentName, sessionId),
    enabled: browserAvailable,
    refetchInterval: browserAvailable ? 3000 : false,
  })
  let latest: BrowserTab | undefined
  let reveal = 0
  for (const candidate of browser.data?.tabs ?? []) {
    const time = candidate.reveal ?? 0
    if (time <= reveal) continue
    latest = candidate
    reveal = time
  }
  if (browser.data && browser.data.epoch !== revealed?.epoch) {
    // The first list is a baseline, not a new agent action. Reloading must
    // not resurrect previews the viewer already dismissed.
    setRevealed({ epoch: browser.data.epoch, time: reveal })
    if (browserFloating) setPanel({ tab, mode: "closed" })
  } else if (latest && revealed && reveal > revealed.time) {
    setRevealed({ epoch: revealed.epoch, time: reveal, tab: latest })
    // Keep the agent's selection for when Browser opens, even if a panel is docked.
    if (!docked) {
      setPanel({ tab, mode: "floating", tabId: latest.id })
    }
  } else if (
    browserFloating &&
    browser.data &&
    !browser.data.tabs.some(({ id }) => id === panel.tabId)
  ) {
    setPanel({ tab, mode: "closed" })
  }
  const views: WorkspaceTool[] = [
    {
      id: "files",
      label: "Files",
      icon: Files,
      render: () => (
        <FilesWorkspace
          agentName={agentName}
          sessionId={sessionId}
          workspaceId={workspaceId}
          onPreviewerOpenChange={setEditorOpen}
        />
      ),
    },
    ...tools,
  ]
  if (browserAvailable) {
    views.push({
      id: "browser",
      label: "Browser",
      icon: Globe,
      render: ({ visible }) => (
        <Browser
          agentName={agentName}
          sessionId={sessionId}
          workspaceId={workspaceId}
          visible={visible}
          query={browser}
          floating={browserFloating}
          reveal={revealed?.tab}
          onFloat={(tabId) => setPanel({ tab: "browser", mode: "floating", tabId })}
          onDock={() => setPanel({ tab: "browser", mode: "docked" })}
          onClosePreview={() => setPanel({ tab, mode: "closed" })}
        />
      ),
    })
  }
  const active = views.find((view) => view.id === tab)

  useEffect(() => {
    onPreviewerOpenChange(docked && tab === "files" && editorOpen)
    return () => onPreviewerOpenChange(false)
  }, [docked, tab, editorOpen, onPreviewerOpenChange])

  const [handledPreview, setHandledPreview] = useState<typeof pendingPreview>()
  if (pendingPreview?.agent === agentName && pendingPreview !== handledPreview) {
    setHandledPreview(pendingPreview)
    setPanel({ tab: "files", mode: "docked" })
  }
  if (visibleTool && !visited.has(visibleTool)) {
    setVisited(new Set(visited).add(visibleTool))
  }

  const togglePanel = useCallback((id: string) => {
    setPanel((current) => ({
      tab: id,
      mode: current.tab === id && current.mode === "docked" ? "closed" : "docked",
    }))
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.code !== "KeyB") return
      event.preventDefault()
      event.stopPropagation()
      togglePanel(tab)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [tab, togglePanel])

  return (
    <>
      <aside
        aria-label="Workspace panel"
        className={cn(
          "min-h-0 min-w-0 shrink-0 flex-col bg-background",
          docked
            ? "absolute inset-y-0 right-12 left-0 z-30 flex border-l lg:relative lg:inset-auto lg:z-auto lg:w-auto lg:max-w-[calc(100%-22rem)]"
            : "contents",
          docked &&
            expanded &&
            "lg:absolute lg:inset-y-0 lg:right-12 lg:left-0 lg:z-30 lg:w-auto lg:max-w-none"
        )}
        style={docked ? { flexBasis: width } : undefined}
      >
        {docked && !expanded ? (
          <WorkspaceResizeHandle
            label="Resize workspace panel"
            width={width}
            min={360}
            max={1000}
            onResize={setWidth}
          />
        ) : null}
        <header
          className={cn(
            "flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b px-3",
            !docked && "hidden"
          )}
        >
          <span className="flex-1 text-sm font-semibold">{active?.label}</span>
          {active?.count !== undefined ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {active.count} {active.count === 1 ? "file" : "files"}
            </span>
          ) : null}
          <Button
            className="hidden lg:inline-flex"
            aria-label={expanded ? "Restore panel size" : "Expand panel"}
            title={expanded ? "Restore panel size" : "Expand panel"}
            size="icon-sm"
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button
            aria-label="Close workspace panel"
            title="Close workspace panel"
            size="icon-sm"
            variant="ghost"
            onClick={() => setPanel((current) => ({ tab: current.tab, mode: "closed" }))}
          >
            <PanelRightClose />
          </Button>
        </header>
        {views.map((view) =>
          visited.has(view.id) ? (
            <div
              key={view.id}
              className={
                view.id === "browser" && browserFloating
                  ? "contents"
                  : cn("flex min-h-0 flex-1 flex-col", visibleTool !== view.id && "hidden")
              }
            >
              {view.render({
                visible: visibleTool === view.id,
                expanded,
                onExpand: () => setExpanded(true),
                onClose: () =>
                  setPanel((current) =>
                    current.mode === "docked" && current.tab === view.id
                      ? { tab: current.tab, mode: "closed" }
                      : current
                  ),
              })}
            </div>
          ) : null
        )}
        {docked ? footer : null}
      </aside>
      <nav
        aria-label="Workspace tools"
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2"
      >
        {views.map(({ id, label, icon: Icon, count }) => {
          const pressed = visibleTool === id
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <Button
                  aria-label={label}
                  aria-pressed={pressed}
                  variant={pressed ? "secondary" : "ghost"}
                  size="icon"
                  className={cn("relative", pressed && "text-primary")}
                  onClick={() => togglePanel(id)}
                >
                  <Icon />
                  {count !== undefined && count > 0 ? (
                    <span className="absolute top-0 right-0 min-w-3.5 rounded-full bg-primary px-0.5 text-[9px] leading-3.5 text-primary-foreground tabular-nums">
                      {count}
                    </span>
                  ) : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{label}</TooltipContent>
            </Tooltip>
          )
        })}
      </nav>
    </>
  )
}

function WorkspaceResizeHandle({
  label,
  width,
  min,
  max,
  onResize,
}: {
  label: string
  width: number
  min: number
  max: number
  onResize: (width: number) => void
}) {
  const drag = useRef<{ width: number; x: number }>(null)
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      className="absolute inset-y-0 left-0 z-30 hidden w-1 cursor-col-resize touch-none transition-colors hover:bg-border focus-visible:bg-ring lg:block"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        onResize(Math.min(max, Math.max(min, width + (event.key === "ArrowLeft" ? 16 : -16))))
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { width, x: event.clientX }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        onResize(Math.min(max, Math.max(min, drag.current.width + drag.current.x - event.clientX)))
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
    />
  )
}
