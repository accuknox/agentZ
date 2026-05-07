"use client"

import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export type WizardStep = {
  id: string
  title: string
  icon: LucideIcon
}

export type WizardShellProps<TStep extends WizardStep> = {
  steps: readonly TStep[]
  currentIndex: number
  currentStepId: TStep["id"]
  direction: number
  children: ReactNode
  layout?: "vertical" | "horizontal"
  panelAdornment?: ReactNode
  canVisitStepAction: (step: TStep, index: number) => boolean
  onStepSelectAction: (step: TStep, index: number) => void
}
