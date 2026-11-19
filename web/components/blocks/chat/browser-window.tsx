"use client"

import { useLayoutEffect, useRef, type ReactNode, type KeyboardEventHandler } from "react"
import { PanelRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserTab } from "@/lib/gateway/client"
import { browserWindowLayout } from "./browser-window-layout"

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
  const saved = useRef<DOMRect>(null)
  const drag = useRef<{ x: number; y: number; width: number; height: number }>(null)
  const moveWindow = useRef<((requested: DOMRect) => void) | null>(null)

  useLayoutEffect(() => {
    const node = windowRef.current
    if (!floating || !node) return
    const chat = node.closest("[data-chat-workspace]")
    const content = chat?.querySelector<HTMLElement>("[data-chat-content]")
    const composer = content?.querySelector<HTMLElement>("[data-chat-composer]")
    let applied: ReturnType<typeof browserWindowLayout> | undefined
    let animation: number | undefined
    const fit = () => {
      const area = content?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)
      const w = 320
      const h = Math.min(320, (w * height) / width)
      const requested =
        saved.current ?? new DOMRect(area.right - w - 12, area.bottom - h - 12, w, h)
      const frame = browserWindowLayout(area, requested, composer?.getBoundingClientRect())
      applied = frame
      Object.assign(node.style, {
        width: `${frame.width}px`,
        height: `${frame.height}px`,
        minWidth: `${frame.minWidth}px`,
        minHeight: `${frame.minHeight}px`,
        left: `${frame.left}px`,
        top: `${frame.top}px`,
      })
    }
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
    fit()
    const observer = new ResizeObserver((entries) => {
      if (applied && entries.some((entry) => entry.target === node)) {
        const rect = node.getBoundingClientRect()
        // A native resize changes the node before the observer runs. Fit
        // changes only the displayed bounds so an obstacle can move away.
        if (Math.abs(rect.width - applied.width) > 1 || Math.abs(rect.height - applied.height) > 1)
          saved.current = rect
      }
      scheduleFit()
    })
    observer.observe(node)
    if (content) observer.observe(content)
    if (composer) observer.observe(composer)
    window.addEventListener("resize", scheduleFit)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", scheduleFit)
      if (animation !== undefined) cancelAnimationFrame(animation)
      // One mounted surface retains its socket/control when it docks. Clear
      // imperative geometry so the inline panel can fill its own container.
      node.removeAttribute("style")
      drag.current = null
      moveWindow.current = null
    }
  }, [floating, width, height])

  return (
    <section
      ref={windowRef}
      onKeyDownCapture={onKeyDownCapture}
      aria-label={floating ? "Floating browser preview" : "Browser"}
      className={
        floating
          ? "group/browser fixed z-40 flex resize flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
          : "flex h-full min-h-0 flex-col bg-background"
      }
    >
      {floating ? (
        <div
          role="toolbar"
          aria-label="Move browser preview"
          title="Use arrow keys to move. Hold Shift to resize."
          tabIndex={0}
          className="absolute inset-x-2 top-2 z-10 flex h-8 cursor-grab touch-none items-center gap-1 rounded-lg border bg-background/95 pl-2 opacity-0 shadow-sm group-focus-within/browser:opacity-100 group-hover/browser:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              (event.target instanceof Element && event.target.closest("button"))
            )
              return
            const node = windowRef.current
            if (!node) return
            const box = node.getBoundingClientRect()
            drag.current = {
              x: event.clientX - box.left,
              y: event.clientY - box.top,
              width: box.width,
              height: box.height,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const held = drag.current
            if (!held) return
            moveWindow.current?.(
              new DOMRect(event.clientX - held.x, event.clientY - held.y, held.width, held.height)
            )
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !event.key.startsWith("Arrow")) return
            event.preventDefault()
            const node = windowRef.current
            if (!node) return
            const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -16 : 16
            const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight"
            const next = node.getBoundingClientRect()
            if (event.shiftKey) {
              if (horizontal) next.width += delta
              else next.height += delta
            } else if (horizontal) next.x += delta
            else next.y += delta
            moveWindow.current?.(next)
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
    </section>
  )
}
