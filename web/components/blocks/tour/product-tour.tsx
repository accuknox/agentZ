"use client"

import { useCallback, useRef, useState } from "react"
import { Rocket } from "lucide-react"
import type { Config, DriveStep, Driver } from "driver.js"
import "driver.js/dist/driver.css"
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar"
import { tourSteps } from "./tour-steps"

/** Elements that are in the DOM but not rendered cannot be highlighted. */
function isVisible(selector: string) {
  const element = document.querySelector(selector)

  return element instanceof HTMLElement && element.getClientRects().length > 0
}

export function ProductTour() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar()
  const driverRef = useRef<Driver | null>(null)
  const [isStarting, setIsStarting] = useState(false)

  const start = useCallback(async () => {
    if (isStarting) return

    setIsStarting(true)
    try {
      // The tour points at sidebar items, so open the sidebar first.
      if (isMobile) {
        setOpenMobile(true)
      } else {
        setOpen(true)
      }

      const { driver } = await import("driver.js")

      // Wait for the sidebar transition, otherwise the highlight measures the
      // collapsed width.
      await new Promise((resolve) => {
        window.setTimeout(resolve, 320)
      })

      const steps: DriveStep[] = tourSteps
        .filter((step) => step.selector === undefined || isVisible(step.selector))
        .map((step) => ({
          element: step.selector,
          popover: {
            align: step.align ?? "start",
            description: step.description,
            side: step.side ?? "right",
            title: step.title,
          },
        }))

      if (steps.length === 0) return

      driverRef.current?.destroy()

      const config: Config = {
        allowClose: true,
        doneBtnText: "Done",
        nextBtnText: "Next",
        onDestroyed: () => {
          driverRef.current = null
        },
        onPopoverRender: (popover) => {
          if (popover.footerButtons.querySelector("[data-tour-skip]")) return

          const skip = document.createElement("button")
          skip.type = "button"
          skip.dataset.tourSkip = "true"
          skip.className = "driver-popover-footer-btn driver-popover-skip-btn"
          skip.textContent = "Skip tour"
          skip.addEventListener("click", () => {
            driverRef.current?.destroy()
          })
          popover.footerButtons.prepend(skip)
        },
        popoverClass: "agentz-tour",
        prevBtnText: "Back",
        showButtons: ["next", "previous", "close"],
        showProgress: true,
        stagePadding: 6,
        stageRadius: 8,
        steps,
      }

      const instance = driver(config)
      driverRef.current = instance
      instance.drive()
    } finally {
      setIsStarting(false)
    }
  }, [isMobile, isStarting, setOpen, setOpenMobile])

  return (
    <SidebarMenuButton
      aria-label="Take a product tour"
      onClick={() => {
        void start()
      }}
      tooltip="Take a product tour"
    >
      <Rocket aria-hidden="true" />
      <span>Take a tour</span>
    </SidebarMenuButton>
  )
}
