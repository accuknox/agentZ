"use client"

import { useLayoutEffect, useRef, type ReactNode, type KeyboardEventHandler } from "react"
import { PanelRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { BrowserTab } from "@/lib/gateway/client"

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
  const drag = useRef<{ x: number; y: number }>(null)
  const fitWindow = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const node = windowRef.current
    if (!floating || !node) return
    const chat = node.closest("[data-chat-workspace]")
    const content = chat?.querySelector("[data-chat-content]")
    const fit = () => {
      const area = content?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)
      const box = node.getBoundingClientRect()
      const w = Math.min(box.width, area.width - 24)
      const h = Math.min(box.height, area.height - 76)
      const left = Math.max(area.left + 12, Math.min(box.left, area.right - w - 12))
      const top = Math.max(area.top + 56, Math.min(box.top, area.bottom - h - 12))
      saved.current = new DOMRect(left, top, w, h)
      Object.assign(node.style, {
        width: `${Math.max(1, w)}px`,
        height: `${Math.max(1, h)}px`,
        minWidth: `${Math.min(240, area.width - 24)}px`,
        minHeight: `${Math.min(150, area.height - 76)}px`,
        left: `${left}px`,
        top: `${top}px`,
      })
    }
    fitWindow.current = fit
    const area = content?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight)
    const w = saved.current?.width ?? 320
    const h = saved.current?.height ?? Math.min(320, (w * height) / width)
    const composer = chat?.querySelector("[data-chat-composer]")?.getBoundingClientRect()
    Object.assign(node.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${saved.current?.left ?? area.right - w - 12}px`,
      top: `${saved.current?.top ?? (composer?.top ?? area.bottom - 160) - h - 12}px`,
    })
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    if (content) observer.observe(content)
    window.addEventListener("resize", fit)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", fit)
      // One mounted surface retains its socket/control when it docks. Clear
      // imperative geometry so the inline panel can fill its own container.
      node.removeAttribute("style")
      drag.current = null
      fitWindow.current = null
    }
  }, [floating, width, height])

  return (
    <section
      ref={windowRef}
      onKeyDownCapture={onKeyDownCapture}
      aria-label={floating ? "Floating browser preview" : "Browser"}
      className={
        floating
          ? "group/browser fixed z-40 flex resize flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
          : "flex h-full min-h-0 flex-col bg-background"
      }
    >
      {floating ? (
        <div
          role="toolbar"
          aria-label="Move browser preview"
          title="Arrow keys move; Shift+Arrow keys resize."
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
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const node = windowRef.current
            const held = drag.current
            if (!node || !held) return
            node.style.left = `${event.clientX - held.x}px`
            node.style.top = `${event.clientY - held.y}px`
            fitWindow.current?.()
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
            if (event.shiftKey) {
              if (horizontal) node.style.width = `${node.offsetWidth + delta}px`
              else node.style.height = `${node.offsetHeight + delta}px`
            } else if (horizontal) node.style.left = `${node.offsetLeft + delta}px`
            else node.style.top = `${node.offsetTop + delta}px`
            fitWindow.current?.()
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
