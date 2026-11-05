"use client"

import { useState, type ComponentProps } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"

export function ValueFlash({
  value,
  children,
  className,
  ...props
}: ComponentProps<"span"> & { value: number }) {
  const reduced = useReducedMotion()
  const [previous, setPrevious] = useState({ value, direction: 0 })
  if (previous.value !== value) {
    setPrevious({ value, direction: Math.sign(value - previous.value) })
  }
  // Anchor popped exit values here, including inside table cells.
  return (
    <span {...props} className={cn("relative inline-block", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          className="inline-block"
          initial={{ opacity: 0, y: reduced ? 0 : previous.direction * 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : previous.direction * -3 }}
          transition={
            reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 34, mass: 0.45 }
          }
        >
          {children ?? value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
