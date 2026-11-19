"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { Globe, Files, Maximize2, Minimize2, PanelRightClose, type LucideIcon } from "lucide-react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { useFileWorkspace } from "./file-workspace-store"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { runBrowser, type BrowserTab } from "@/lib/gateway/client"
import { cn } from "@/lib/utils"

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
  const browserEnabled = agents.find((agent) => agent.name === agentName)?.browser.enabled ?? false
  const [{ tab, open }, setPanel] = useState({ tab: initialTool, open: false })
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [floatingTab, setFloatingTab] = useState<string>()
  const browserFloating = floatingTab !== undefined
  const [revealed, setRevealed] = useState<{
    epoch: string
    time: number
    tab?: Pick<BrowserTab, "id" | "reveal">
  }>()
  const panelOpen = open && !(tab === "browser" && browserFloating)
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
    ...(browserEnabled && sessionId
      ? [
          {
            id: "browser",
            label: "Browser",
            icon: Globe,
            render: ({ visible }: { visible: boolean }) => (
              <Browser
                agentName={agentName}
                sessionId={sessionId}
                workspaceId={workspaceId}
                visible={visible || browserFloating}
                query={browser}
                floating={browserFloating}
                reveal={revealed?.tab}
                onFloatingChange={(floating, id) => {
                  setFloatingTab(floating ? id : undefined)
                  if (!floating || tab === "browser") setPanel({ tab: "browser", open: !floating })
                }}
                onClosePreview={() => {
                  setFloatingTab(undefined)
                  if (tab === "browser") setPanel({ tab: "browser", open: false })
                }}
              />
            ),
          },
        ]
      : []),
  ]
  const browser = useQuery(
    queryOptions({
      queryKey: ["browser", workspaceId, agentName, sessionId],
      queryFn: async ({ signal }) => {
        if (!sessionId) throw new Error("Session is required")
        const { data } = await runBrowser({
          path: { agentName, sessionId },
          body: { operation: "status" },
          headers: { "X-AgentZ-Workspace-ID": workspaceId },
          signal,
          throwOnError: true,
        })
        return data
      },
      enabled: browserEnabled && !!sessionId,
      refetchInterval: browserEnabled && sessionId ? 3000 : false,
      retry: false,
    })
  )
  let latest: BrowserTab | undefined
  let reveal = 0
  for (const candidate of browser.data?.tabs ?? []) {
    if ((candidate.reveal ?? 0) <= reveal) continue
    latest = candidate
    reveal = candidate.reveal ?? 0
  }
  if (browser.data && browser.data.epoch !== revealed?.epoch) {
    // The first list is a baseline, not a new agent action. Reloading must
    // not resurrect previews the viewer already dismissed.
    setRevealed({ epoch: browser.data.epoch, time: reveal })
    setFloatingTab(undefined)
  } else if (latest && revealed && reveal > revealed.time) {
    setRevealed({ epoch: revealed.epoch, time: reveal, tab: latest })
    if (!(open && tab === "browser" && !browserFloating)) setFloatingTab(latest.id)
    setVisited((current) => new Set(current).add("browser"))
  } else if (
    floatingTab &&
    browser.data &&
    !browser.data.tabs.some((tab) => tab.id === floatingTab)
  )
    setFloatingTab(undefined)
  const active = views.find((view) => view.id === tab)

  useEffect(() => {
    onPreviewerOpenChange(open && tab === "files" && editorOpen)
    return () => onPreviewerOpenChange(false)
  }, [open, tab, editorOpen, onPreviewerOpenChange])

  const [handledPreview, setHandledPreview] = useState<typeof pendingPreview>()
  if (pendingPreview?.agent === agentName && pendingPreview !== handledPreview) {
    setHandledPreview(pendingPreview)
    setPanel({ tab: "files", open: true })
    setVisited((current) => new Set(current).add("files"))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.code !== "KeyB") return
      event.preventDefault()
      event.stopPropagation()
      if (browserFloating && tab === "browser") {
        setFloatingTab(undefined)
        setPanel({ tab: "browser", open: true })
        return
      }
      setVisited((current) => new Set(current).add(tab))
      setPanel((current) => ({ ...current, open: !current.open }))
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [tab, browserFloating])

  return (
    <>
      <aside
        aria-label="Workspace panel"
        className={cn(
          "min-h-0 min-w-0 shrink-0 flex-col bg-background",
          panelOpen
            ? "absolute inset-y-0 right-12 left-0 z-30 flex border-l lg:relative lg:inset-auto lg:z-auto lg:w-auto lg:max-w-[calc(100%-22rem)]"
            : "contents",
          panelOpen &&
            expanded &&
            "lg:absolute lg:inset-y-0 lg:right-12 lg:left-0 lg:z-30 lg:w-auto lg:max-w-none"
        )}
        style={panelOpen ? { flexBasis: width } : undefined}
      >
        {panelOpen && !expanded ? (
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
            !panelOpen && "hidden"
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
            onClick={() => setPanel((current) => ({ ...current, open: false }))}
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
                  : cn("flex min-h-0 flex-1 flex-col", (tab !== view.id || !panelOpen) && "hidden")
              }
            >
              {view.render({
                visible: panelOpen && tab === view.id,
                expanded,
                onExpand: () => setExpanded(true),
                onClose: () =>
                  setPanel((current) =>
                    current.tab === view.id ? { ...current, open: false } : current
                  ),
              })}
            </div>
          ) : null
        )}
        {panelOpen ? footer : null}
      </aside>
      <nav
        aria-label="Workspace tools"
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2"
      >
        {views.map(({ id, label, icon: Icon, count }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                aria-label={label}
                aria-pressed={(panelOpen && tab === id) || (id === "browser" && browserFloating)}
                variant={
                  (panelOpen && tab === id) || (id === "browser" && browserFloating)
                    ? "secondary"
                    : "ghost"
                }
                size="icon"
                className={cn(
                  "relative",
                  ((panelOpen && tab === id) || (id === "browser" && browserFloating)) &&
                    "text-primary"
                )}
                onClick={() => {
                  if (id === "browser" && browserFloating) {
                    setFloatingTab(undefined)
                    setPanel({ tab: id, open: true })
                    return
                  }
                  setPanel((current) => ({
                    tab: id,
                    open: current.tab === id ? !current.open : true,
                  }))
                  setVisited((current) => new Set(current).add(id))
                }}
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
        ))}
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
