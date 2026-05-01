"use client"

import { Button } from "@/components/ui/button"
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
      className="flex w-full list-none flex-col gap-3 md:h-full md:w-40 md:shrink-0 md:gap-0 lg:w-72"
      role="tablist"
      aria-orientation="vertical"
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
            className="group peer grid min-h-0 grid-cols-[auto_1fr] grid-rows-[2rem_1fr] gap-x-3 md:flex-1 md:last:flex-none lg:grid-rows-[3.75rem_1fr]"
            data-status={status}
          >
            <Button
              className="size-8 rounded-full lg:size-15 [&_svg:not([class*='size-'])]:size-5 lg:[&_svg:not([class*='size-'])]:size-8"
              variant={isInactive ? "secondary" : "default"}
              size="icon"
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
              <Icon />
            </Button>
            <div className="flex min-w-0 items-center">
              <h4 className="text-base font-medium">{step.title}</h4>
            </div>
            <div className="flex justify-center">
              {!isLast && (
                <div
                  aria-hidden="true"
                  data-status={status}
                  className="hidden h-full w-0.5 bg-muted transition-all duration-300 ease-in-out data-[status=success]:bg-primary data-disabled:opacity-50 md:block"
                />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
