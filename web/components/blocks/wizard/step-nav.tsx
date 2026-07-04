"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WizardStep } from "./types"

export function WizardStepNav<TStep extends WizardStep>({
  canVisitStepAction,
  currentIndex,
  onStepSelectAction,
  steps,
}: {
  canVisitStepAction: (step: TStep, index: number) => boolean
  currentIndex: number
  onStepSelectAction: (step: TStep, index: number) => void
  steps: readonly TStep[]
}) {
  return (
    <ol
      className="flex w-full max-w-xs list-none flex-col items-stretch gap-2 sm:w-auto sm:max-w-full sm:flex-row sm:flex-nowrap sm:items-center sm:justify-center sm:gap-3"
      role="tablist"
    >
      {steps.map((step, index) => {
        const disabled = !canVisitStepAction(step, index)
        const isActive = index === currentIndex
        const isInactive = index > currentIndex
        const isLast = index === steps.length - 1
        const status = index < currentIndex ? "success" : isActive ? "active" : "inactive"
        const Icon = step.icon

        return (
          <li
            key={step.id}
            className="group flex min-h-0 w-full max-w-full shrink-0 items-center gap-2 sm:w-auto"
            data-status={status}
          >
            <Button
              className="grid min-h-0 w-full min-w-0 grid-cols-[auto_1fr] items-center justify-start gap-2 rounded-md p-1 text-left sm:w-auto"
              variant="plain"
              type="button"
              role="tab"
              id={`wizard-step-${step.id}`}
              aria-controls={`wizard-panel-${step.id}`}
              aria-current={isActive ? "step" : undefined}
              aria-posinset={index + 1}
              aria-selected={isActive}
              aria-setsize={steps.length}
              disabled={disabled}
              onClick={() => onStepSelectAction(step, index)}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full lg:size-8 [&_svg:not([class*='size-'])]:size-3.5 lg:[&_svg:not([class*='size-'])]:size-4",
                  isInactive
                    ? "bg-secondary text-secondary-foreground"
                    : "bg-primary text-primary-foreground"
                )}
              >
                <Icon />
              </span>
              <span className="truncate text-sm font-medium">{step.title}</span>
            </Button>
            <div className="hidden w-16 justify-center sm:flex lg:w-32">
              {!isLast && (
                <div
                  aria-hidden="true"
                  data-status={status}
                  className="bg-muted data-[status=success]:bg-primary h-0.5 w-full transition-colors duration-300 ease-in-out"
                />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
