"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { Files, Maximize2, Minimize2, PanelRightClose, type LucideIcon } from "lucide-react"
import { useFileWorkspace } from "./file-workspace-store"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const FilesWorkspace = dynamic(
  () => import("./files-workspace").then((module) => module.FilesWorkspace),
  { ssr: false }
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
  const [{ tab, open }, setPanel] = useState({ tab: initialTool, open: false })
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState(480)
  const [expanded, setExpanded] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
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
      setVisited((current) => new Set(current).add(tab))
      setPanel((current) => ({ ...current, open: !current.open }))
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [tab])

  return (
    <>
      <aside
        aria-label="Workspace panel"
        className={cn(
          "bg-background min-h-0 min-w-0 shrink-0 flex-col border-l",
          open
            ? "absolute inset-y-0 right-12 left-0 z-30 flex lg:relative lg:inset-auto lg:z-auto lg:w-auto lg:max-w-[calc(100%-22rem)]"
            : "hidden",
          expanded &&
            "lg:absolute lg:inset-y-0 lg:right-12 lg:left-0 lg:z-30 lg:w-auto lg:max-w-none"
        )}
        style={{ flexBasis: width }}
      >
        {!expanded ? (
          <WorkspaceResizeHandle
            label="Resize workspace panel"
            width={width}
            min={360}
            max={1000}
            onResize={setWidth}
          />
        ) : null}
        <header className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b px-3">
          <span className="flex-1 text-sm font-semibold">{active?.label}</span>
          {active?.count !== undefined ? (
            <span className="text-muted-foreground text-xs tabular-nums">
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
              className={cn("flex min-h-0 flex-1 flex-col", tab !== view.id && "hidden")}
            >
              {view.render({
                visible: open && tab === view.id,
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
        {footer}
      </aside>
      <nav
        aria-label="Workspace tools"
        className="bg-sidebar flex w-12 shrink-0 flex-col items-center gap-1 border-l py-2"
      >
        {views.map(({ id, label, icon: Icon, count }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                aria-label={label}
                aria-pressed={open && tab === id}
                variant={open && tab === id ? "secondary" : "ghost"}
                size="icon"
                className={cn("relative", open && tab === id && "text-primary")}
                onClick={() => {
                  setPanel((current) => ({
                    tab: id,
                    open: current.tab === id ? !current.open : true,
                  }))
                  setVisited((current) => new Set(current).add(id))
                }}
              >
                <Icon />
                {count !== undefined && count > 0 ? (
                  <span className="bg-primary text-primary-foreground absolute top-0 right-0 min-w-3.5 rounded-full px-0.5 text-[9px] leading-3.5 tabular-nums">
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
      className="hover:bg-border focus-visible:bg-ring absolute inset-y-0 left-0 z-30 hidden w-1 cursor-col-resize touch-none transition-colors lg:block"
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
