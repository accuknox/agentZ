"use client"

import {
  useLayoutEffect,
  useRef,
  type ReactNode,
  type KeyboardEventHandler,
  type PointerEvent,
} from "react"
import { PanelRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserTab } from "@/lib/gateway/client"
import {
  browserWindowLayout,
  resizeBrowserWindow,
  type BrowserWindowRequest,
} from "./browser-window-layout"

const resizeHandles = [
  { x: -1, y: 0, className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { x: 1, y: 0, className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { x: 0, y: -1, className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { x: 0, y: 1, className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { x: -1, y: -1, className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { x: 1, y: -1, className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { x: -1, y: 1, className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { x: 1, y: 1, className: "right-0 bottom-0 size-3 cursor-nwse-resize" },
]

const arrowKeys = new Map<string, readonly [number, number]>([
  ["ArrowLeft", [-1, 0]],
  ["ArrowRight", [1, 0]],
  ["ArrowUp", [0, -1]],
  ["ArrowDown", [0, 1]],
])

export function BrowserWindow({
  floating,
  title,
  width,
  height,
  onDock,
  onClose,
  children,
  onKeyDownCapture,
}: {
  floating: boolean
  onDock: () => void
  onClose: () => void
  onKeyDownCapture?: KeyboardEventHandler<HTMLElement>
  children: ReactNode
} & Pick<BrowserTab, "title" | "width" | "height">) {
  const windowRef = useRef<HTMLElement>(null)
  const saved = useRef<BrowserWindowRequest | undefined>(undefined)
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    frame: DOMRect
    x: number
    y: number
  }>(null)
  const moveWindow = useRef<((requested: BrowserWindowRequest) => void) | null>(null)

  useLayoutEffect(() => {
    const node = windowRef.current
    if (!floating || !node) return
    const chat = node.closest("[data-chat-workspace]")
    const canvas = chat?.querySelector<HTMLElement>("[data-chat-canvas]")
    if (!canvas) return
    let area = canvas.getBoundingClientRect()
    const fit = () => {
      const frame = browserWindowLayout(area, { width, height }, saved.current)
      canvas.style.setProperty("--browser-preview-right", `${frame.insetRight}px`)
      canvas.style.setProperty("--browser-preview-bottom", `${frame.insetBottom}px`)
      canvas.toggleAttribute("data-browser-beside", frame.insetRight > 0)
      Object.assign(node.style, {
        width: `${frame.width}px`,
        height: `${frame.height}px`,
        left: `${frame.left}px`,
        top: `${frame.top}px`,
      })
    }
    fit()
    let animation: number | undefined
    const scheduleFit = () => {
      if (animation !== undefined) return
      animation = requestAnimationFrame(() => {
        animation = undefined
        fit()
      })
    }
    moveWindow.current = (requested) => {
      saved.current = requested
      scheduleFit()
    }
    const measure = () => {
      area = canvas.getBoundingClientRect()
      fit()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(canvas, { box: "border-box" })
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      if (animation !== undefined) cancelAnimationFrame(animation)
      // The same window docks without losing its live connection.
      node.removeAttribute("style")
      canvas.style.removeProperty("--browser-preview-right")
      canvas.style.removeProperty("--browser-preview-bottom")
      canvas.removeAttribute("data-browser-beside")
      drag.current = null
      moveWindow.current = null
    }
  }, [floating, width, height])

  function startDrag(event: PointerEvent<HTMLDivElement>, x = 0, y = 0) {
    if (event.button !== 0 || drag.current) return
    if (event.target instanceof Element && event.target.closest("button")) return
    const node = windowRef.current
    if (!node) return
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      frame: node.getBoundingClientRect(),
      x,
      y,
    }
    if (!x && !y) event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function dragWindow(event: PointerEvent<HTMLDivElement>) {
    const held = drag.current
    if (!held || held.pointerId !== event.pointerId) return
    const { frame, x, y } = held
    const dx = event.clientX - held.startX
    const dy = event.clientY - held.startY
    changeFrame(frame, dx, dy, x, y)
  }

  function changeFrame(frame: DOMRect, dx: number, dy: number, x = 0, y = 0) {
    moveWindow.current?.(
      x || y
        ? resizeBrowserWindow(frame, x, y, dx, dy)
        : { left: frame.left + dx, top: frame.top + dy, width: frame.width }
    )
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }

  return (
    <section
      ref={windowRef}
      onKeyDownCapture={onKeyDownCapture}
      aria-label={floating ? "Floating browser preview" : "Browser"}
      className={
        floating
          ? "group/browser fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
          : "flex h-full min-h-0 flex-col bg-background"
      }
    >
      {floating ? (
        <div
          role="toolbar"
          aria-label="Move or resize browser preview"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
          tabIndex={0}
          className="absolute inset-x-2 top-2 z-10 flex h-8 cursor-grab touch-none items-center gap-1 rounded-lg border bg-background/95 pl-2 opacity-0 shadow-sm group-focus-within/browser:opacity-100 group-hover/browser:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
          onPointerDown={(event) => startDrag(event)}
          onPointerMove={dragWindow}
          onLostPointerCapture={endDrag}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            const direction = arrowKeys.get(event.key)
            const node = windowRef.current
            if (!direction || !node) return
            event.preventDefault()
            const [x, y] = direction
            const frame = node.getBoundingClientRect()
            if (event.shiftKey) {
              changeFrame(frame, -16 * x, -16 * y, -Math.abs(x), -Math.abs(y))
              return
            }
            changeFrame(frame, 16 * x, 16 * y)
          }}
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
          {[
            { label: "Dock browser", Icon: PanelRight, onClick: onDock },
            { label: "Hide browser preview", Icon: X, onClick: onClose },
          ].map(({ label, Icon, onClick }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={label} onClick={onClick}>
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
      {children}
      {floating
        ? resizeHandles.map(({ x, y, className }) => (
            <div
              key={`${x}:${y}`}
              aria-hidden="true"
              className={`absolute z-20 touch-none ${className}`}
              onPointerDown={(event) => startDrag(event, x, y)}
              onPointerMove={dragWindow}
              onLostPointerCapture={endDrag}
            />
          ))
        : null}
    </section>
  )
}
