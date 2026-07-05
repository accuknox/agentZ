"use client"

import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import { motion } from "motion/react"
import Image from "next/image"
import { useEffect, useState, type ReactElement } from "react"

/** The emblem spinning steadily clockwise - a sleek "agent thinking" tell. */
function WorkingEmblem(): ReactElement {
  return (
    <motion.span
      className="inline-flex size-[30px]"
      initial={{ rotate: 0 }}
      animate={{ rotate: 360 }}
      transition={{ duration: 2.5, ease: "linear", repeat: Number.POSITIVE_INFINITY }}
    >
      <Image alt="" aria-hidden="true" height={30} priority src="/emblem.svg" width={30} />
    </motion.span>
  )
}

export type AgentWorkingIndicatorProps = {
  isWorking: boolean
  className?: string
}

/**
 * Shows a shimmer "Working..." text while the agent is busy.
 *
 * Render-time setState avoids cascading renders from useEffect.
 * The 260ms hide delay prevents flicker when the agent finishes.
 */
export function AgentWorkingIndicator({
  isWorking,
  className,
}: AgentWorkingIndicatorProps): ReactElement {
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
      className={cn("inline-flex items-center gap-2", className)}
      style={{
        opacity: isWorking ? 1 : 0,
        transition: "opacity 220ms ease-out",
      }}
    >
      <WorkingEmblem />
      <Shimmer>Working...</Shimmer>
    </div>
  )
}
