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
      className="flex w-full max-w-6xl list-none flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3"
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
            className={cn(
              "group flex min-h-0 w-full max-w-full items-center",
              isLast ? "sm:w-auto sm:shrink-0" : "sm:flex-1"
            )}
            data-status={status}
          >
            <Button
              className="flex min-h-0 w-full min-w-0 items-center justify-start gap-2 rounded-md p-1 text-left sm:w-auto sm:max-w-full sm:shrink-0"
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
              <span className="min-w-0 truncate text-sm font-medium sm:whitespace-nowrap">
                {step.title}
              </span>
            </Button>
            {!isLast && (
              <div
                aria-hidden="true"
                data-status={status}
                className="bg-muted data-[status=success]:bg-primary ml-3 hidden h-0.5 min-w-8 flex-1 transition-colors duration-300 ease-in-out sm:block"
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
