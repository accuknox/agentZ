"use client"

import { WizardPanel } from "./panel"
import { WizardStepNav } from "./step-nav"
import type { WizardShellProps, WizardStep } from "./types"
import { cn } from "@/lib/utils"

export function WizardShell<TStep extends WizardStep>({
  canVisitStepAction,
  children,
  currentIndex,
  currentStepId,
  direction,
  layout = "vertical",
  onStepSelectAction,
  panelAdornment,
  steps,
}: WizardShellProps<TStep>) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4",
        layout === "vertical" && "md:flex-row md:gap-5",
        layout === "horizontal" && "items-center"
      )}
    >
      <div className={cn(layout === "horizontal" && "flex w-full justify-center")}>
        <WizardStepNav
          canVisitStepAction={canVisitStepAction}
          currentIndex={currentIndex}
          layout={layout}
          onStepSelectAction={onStepSelectAction}
          steps={steps}
        />
      </div>
      <WizardPanel
        direction={direction}
        layout={layout}
        panelAdornment={panelAdornment}
        stepKey={currentStepId}
      >
        <div
          id={`wizard-panel-${currentStepId}`}
          role="tabpanel"
          aria-labelledby={`wizard-step-${currentStepId}`}
          tabIndex={0}
          className="min-h-0"
        >
          {children}
        </div>
      </WizardPanel>
    </div>
  )
}
