"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { Rocket } from "lucide-react"
import { toast } from "sonner"
import type { DriveStep, Driver } from "driver.js"
import { buttonVariants } from "@/components/ui/button"
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import styles from "./product-tour.module.css"

const steps = [
  ["workspace", "Switch workspaces", "Move between your team's workspaces."],
  ["new-chat", "Start a chat", "Pick an agent and ask it to help with a task."],
  ["search-chats", "Find a chat", "Search past chats and pick up where you left off."],
  [
    "lens",
    "See what agents did",
    "Review agent actions, tool calls, and network or process activity.",
  ],
  [
    "skills",
    "Import/Export skills",
    "Skills are folders that include instructions, scripts, and resources that your agents can load when needed.",
  ],
  ["mcps", "Connect your tools", "Add MCP connections so agents can use your tools and services."],
  [
    "sandboxes",
    "Set up sandboxes",
    "Choose the software and tools available to your agents and control their network access.",
  ],
  ["inference", "Choose AI models"],
  [
    "secrets",
    "Add credentials",
    "Add API keys and passwords for your services. Agents use these credentials without seeing their values.",
  ],
  [
    "workflows",
    "View workflows",
    "See each step in a workflow your agent created and how the steps connect.",
  ],
  ["triggers", "Set up triggers", "Run workflows on a schedule or through a webhook."],
  [
    "dashboards",
    "View dashboards",
    "Open dashboards your agents created to view data and reports.",
  ],
  ["agents", "Choose an agent", "Browse the agents in this workspace and see what each can do."],
  ["roles", "Manage access", "Control who can use and manage resources in this workspace."],
  ["event-trail", "Review changes", "See who made changes in this workspace and when."],
] as const

export function ProductTour() {
  const { isMobile, open, setOpen } = useSidebar()
  const pathname = usePathname()
  const stopRef = useRef<(() => void) | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => () => stopRef.current?.(), [pathname, isMobile])

  useEffect(() => {
    if (!open) stopRef.current?.()
  }, [open])

  async function start(trigger: HTMLButtonElement) {
    if (stopRef.current || isMobile) return

    const sidebar = trigger.closest<HTMLElement>("[data-app-sidebar]")
    if (!sidebar) return

    const controller = new AbortController()
    const { signal } = controller
    let instance: Driver | undefined
    let observer: MutationObserver | undefined
    let resize: ResizeObserver | undefined
    let timeout: number | undefined
    let frame = 0

    function stop() {
      if (signal.aborted) return
      controller.abort()
      window.clearTimeout(timeout)
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      resize?.disconnect()
      instance?.destroy()
      stopRef.current = null
      setStarting(false)
      if (!open) setOpen(false)
      if (trigger.isConnected) trigger.focus({ preventScroll: true })
    }

    stopRef.current = stop
    setStarting(true)
    if (!open) setOpen(true)

    try {
      const { driver } = await import("driver.js")
      if (signal.aborted) return

      // React must commit the expanded sidebar before measuring its transition.
      await new Promise<void>((resolve) => {
        frame = window.requestAnimationFrame(() => resolve())
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      if (signal.aborted) return
      await Promise.allSettled(sidebar.getAnimations().map((animation) => animation.finished))
      if (signal.aborted) return

      // Chat history streams separately. Do not mistake its skeleton for a
      // workspace where the user cannot access chats.
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          if (
            sidebar.querySelector('[data-tour="navigation"]') &&
            !sidebar.querySelector('[data-tour="loading-chats"]')
          ) {
            resolve()
          }
        }
        observer = new MutationObserver(ready)
        observer.observe(sidebar, { childList: true, subtree: true })
        timeout = window.setTimeout(() => reject(new Error("Tour targets did not load")), 5000)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        ready()
      })
      window.clearTimeout(timeout)
      observer?.disconnect()
      if (signal.aborted) return

      const available = steps.flatMap<DriveStep>(([id, title, description]) => {
        const element = sidebar.querySelector(`[data-tour="${id}"]`)
        if (!element?.checkVisibility({ visibilityProperty: true })) return []
        return [
          {
            element,
            popover: {
              title,
              description: element.getAttribute("data-tour-description") ?? description,
              side: "right",
              align: "start",
            },
          },
        ]
      })
      if (available.length === 0) {
        stop()
        return
      }

      instance = driver({
        steps: available,
        animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        duration: 150,
        disableActiveInteraction: true,
        overlayColor: "var(--foreground)",
        overlayOpacity: 0.15,
        popoverClass: styles.popover,
        popoverOffset: 8,
        stagePadding: 4,
        stageRadius: 6,
        showProgress: true,
        prevBtnText: "Back",
        nextBtnText: "Next",
        doneBtnText: "Finish",
        // onDestroyed is skipped if the first highlight is still animating.
        onDestroyStarted: stop,
        onHighlightStarted: (element) => {
          // Driver checks the window viewport, not clipping by sidebar sections.
          element?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" })
        },
        onPopoverRender: ({ previousButton, nextButton, closeButton, progress }) => {
          // Driver's inline display overrides the shared button flex alignment.
          for (const button of [previousButton, nextButton, closeButton]) {
            button.style.removeProperty("display")
          }
          previousButton.className = buttonVariants({
            variant: "outline",
            size: "sm",
            className: "driver-popover-prev-btn",
          })
          nextButton.className = buttonVariants({
            size: "sm",
            className: "driver-popover-next-btn",
          })
          closeButton.className = buttonVariants({
            variant: "ghost",
            size: "icon-sm",
            className: "driver-popover-close-btn",
          })
          closeButton.setAttribute("aria-label", "Close tour")
          progress.setAttribute("aria-live", "polite")
        },
      })

      function refresh() {
        const element = instance?.getActiveElement()
        if (
          element &&
          (!element.isConnected || !element.checkVisibility({ visibilityProperty: true }))
        ) {
          stop()
          return
        }
        instance?.refresh()
      }

      sidebar.addEventListener("scroll", refresh, { capture: true, signal })
      observer = new MutationObserver(refresh)
      observer.observe(sidebar, { childList: true, subtree: true })
      resize = new ResizeObserver(refresh)
      resize.observe(sidebar)
      sidebar.querySelectorAll("[data-tour]").forEach((element) => resize?.observe(element))
      setStarting(false)
      instance.drive()
    } catch {
      if (signal.aborted) return
      stop()
      toast.error("Couldn't start the tour. Try again.")
    }
  }

  if (isMobile) return null

  return (
    <SidebarMenuButton
      aria-busy={starting}
      aria-disabled={starting}
      className="hidden md:flex"
      onClick={(event) => void start(event.currentTarget)}
      tooltip="Take a tour"
    >
      {starting ? <Spinner /> : <Rocket aria-hidden="true" />}
      <span>{starting ? "Starting tour..." : "Take a tour"}</span>
    </SidebarMenuButton>
  )
}
