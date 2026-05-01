"use client"

import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"

const formVariants = {
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
}

export function WizardPanel({
  children,
  direction,
  panelAdornment,
  stepKey,
}: {
  children: ReactNode
  direction: number
  panelAdornment?: ReactNode
  stepKey: string | number
}) {
  return (
    <div className="relative mt-6 min-h-70 flex-1 rounded border bg-card p-4 sm:p-6 md:min-h-0">
      {panelAdornment}
      <div className="h-full overflow-hidden">
        <AnimatePresence custom={direction} mode="wait" initial={false}>
          <motion.div
            key={stepKey}
            custom={direction}
            variants={formVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
