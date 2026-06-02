"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WizardStep } from "./types"

export function WizardStepNav<TStep extends WizardStep>({
  canVisitStepAction,
  currentIndex,
  layout = "vertical",
  onStepSelectAction,
  steps,
}: {
  canVisitStepAction: (step: TStep, index: number) => boolean
  currentIndex: number
  layout?: "vertical" | "horizontal"
  onStepSelectAction: (step: TStep, index: number) => void
  steps: readonly TStep[]
}) {
  return (
    <ol
      className={cn(
        "flex w-full list-none gap-3",
        layout === "vertical"
          ? "flex-col md:h-full md:w-32 md:shrink-0 md:gap-0 lg:w-45"
          : "w-auto max-w-full flex-row items-center justify-center"
      )}
      role="tablist"
      aria-orientation={layout}
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
              "group peer min-h-0",
              layout === "vertical"
                ? "grid grid-cols-[auto_1fr] grid-rows-[2rem_1fr] gap-x-2 md:flex-1 md:last:flex-none lg:grid-rows-[2.25rem_1fr]"
                : "flex items-center gap-2"
            )}
            data-status={status}
          >
            <Button
              className="size-6 rounded-full lg:size-8 [&_svg:not([class*='size-'])]:size-3.5 lg:[&_svg:not([class*='size-'])]:size-4"
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
              <h4 className="truncate text-sm font-medium">{step.title}</h4>
            </div>
            <div className={cn("flex justify-center", layout === "horizontal" && "w-32")}>
              {!isLast && (
                <div
                  aria-hidden="true"
                  data-status={status}
                  className={cn(
                    "bg-muted data-[status=success]:bg-primary transition-all duration-300 ease-in-out data-disabled:opacity-50",
                    layout === "vertical" ? "hidden h-full w-0.5 md:block" : "h-0.5 w-full"
                  )}
                />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
