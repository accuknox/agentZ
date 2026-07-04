"use client"

import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"

const panelVariants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? 24 : -24,
  }),
  center: {
    opacity: 1,
    x: 0,
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction > 0 ? -24 : 24,
  }),
} as const

export function WizardPanel({
  children,
  direction,
  stepKey,
}: {
  children: ReactNode
  direction: number
  stepKey: string | number
}) {
  return (
    <div className="bg-card relative min-h-0 w-full flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
        <AnimatePresence custom={direction} mode="wait" initial={false}>
          <motion.div
            key={stepKey}
            custom={direction}
            variants={panelVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex min-h-full flex-col"
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
