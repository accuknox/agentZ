"use client"

import { cn } from "@/lib/utils"
import { motion, useReducedMotion } from "motion/react"
import Image from "next/image"
import { useEffect, useState, type ReactElement } from "react"

/** WorkingBot keeps the character upright while its visor and thoughts show activity. */
function WorkingBot({ reducedMotion }: { reducedMotion: boolean }): ReactElement {
  return (
    <span aria-hidden="true" className="relative inline-flex h-[30px] w-9 shrink-0 items-end">
      <motion.span
        animate={reducedMotion ? undefined : { scale: [1, 1.025, 1], y: [0, -1.5, 0] }}
        className="relative inline-flex h-[29px] w-[30px] origin-bottom"
        transition={{ duration: 2.4, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }}
      >
        <Image alt="" className="h-[29px] w-[30px]" height={29} src="/agentz-bot.svg" width={30} />
        <span className="absolute top-[36%] left-[39%] h-[29%] w-1/2 overflow-hidden rounded-full">
          <motion.span
            animate={reducedMotion ? undefined : { x: ["-100%", "650%"] }}
            className="absolute inset-y-0 left-0 w-1 bg-linear-to-r from-transparent via-cyan-200/70 to-transparent blur-[0.5px]"
            transition={{ duration: 2.4, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }}
          />
        </span>
      </motion.span>
      <span className="absolute top-0 right-0 flex items-end gap-px">
        {[0, 0.22, 0.44].map((delay, index) => (
          <motion.span
            animate={
              reducedMotion
                ? undefined
                : { opacity: [0.2, 0.9, 0.2], scale: [0.75, 1, 0.75], y: [1, -1, 1] }
            }
            className={cn(
              "block rounded-full",
              index === 0 ? "size-1 bg-blue-600" : "size-1.5 bg-violet-500"
            )}
            key={delay}
            transition={{
              delay,
              duration: 1.8,
              ease: "easeInOut",
              repeat: Number.POSITIVE_INFINITY,
            }}
          />
        ))}
      </span>
    </span>
  )
}

export type AgentWorkingIndicatorProps = {
  isWorking: boolean
  className?: string
}

/**
 * Shows the AgentZ bot thinking while the agent is busy.
 *
 * Render-time setState avoids cascading renders from useEffect.
 * The 260ms hide delay prevents flicker when the agent finishes.
 */
export function AgentWorkingIndicator({
  isWorking,
  className,
}: AgentWorkingIndicatorProps): ReactElement {
  const reducedMotion = useReducedMotion() ?? false
  const [visible, setVisible] = useState(isWorking)

  if (isWorking && !visible) {
    setVisible(true)
  }

  useEffect(() => {
    if (isWorking) return
    const timer = setTimeout(() => setVisible(false), 260)
    return () => clearTimeout(timer)
  }, [isWorking])

  if (!visible) return <></>

  return (
    <div
      aria-live="polite"
      className={cn("inline-flex items-center gap-2", className)}
      role="status"
      style={{
        opacity: isWorking ? 1 : 0,
        transition: "opacity 220ms ease-out",
      }}
    >
      <WorkingBot reducedMotion={reducedMotion} />
      <span className="text-muted-foreground">Working...</span>
    </div>
  )
}
