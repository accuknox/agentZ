"use client"

import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"
import type { WizardLayout } from "./types"

const panelVariants = {
  vertical: {
    enter: (direction: number) => ({
      opacity: 0,
      y: direction > 0 ? 24 : -24,
    }),
    center: {
      opacity: 1,
      y: 0,
    },
    exit: (direction: number) => ({
      opacity: 0,
      y: direction > 0 ? -24 : 24,
    }),
  },
  horizontal: {
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
  },
}

export function WizardPanel({
  children,
  direction,
  layout = "vertical",
  panelAdornment,
  stepKey,
}: {
  children: ReactNode
  direction: number
  layout?: WizardLayout
  panelAdornment?: ReactNode
  stepKey: string | number
}) {
  return (
    <div className="bg-card relative mt-6 min-h-0 w-full flex-1 overflow-hidden rounded border">
      {panelAdornment}
      <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <AnimatePresence custom={direction} mode="wait" initial={false}>
          <motion.div
            key={stepKey}
            custom={direction}
            variants={panelVariants[layout]}
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
