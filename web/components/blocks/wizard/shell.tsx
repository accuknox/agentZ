"use client"

import { WizardPanel } from "./panel"
import { WizardStepNav } from "./step-nav"
import type { WizardShellProps, WizardStep } from "./types"
import { Separator } from "@/components/ui/separator"

export function WizardShell<TStep extends WizardStep>({
  canVisitStepAction,
  children,
  currentIndex,
  currentStepId,
  direction,
  onStepSelectAction,
  steps,
}: WizardShellProps<TStep>) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center">
      <div className="flex w-full justify-start px-4 sm:justify-center sm:px-0">
        <WizardStepNav
          canVisitStepAction={canVisitStepAction}
          currentIndex={currentIndex}
          onStepSelectAction={onStepSelectAction}
          steps={steps}
        />
      </div>
      <Separator className="my-6" />
      <WizardPanel direction={direction} stepKey={currentStepId}>
        <div
          id={`wizard-panel-${currentStepId}`}
          role="tabpanel"
          aria-labelledby={`wizard-step-${currentStepId}`}
          tabIndex={0}
          className="min-h-0 w-full min-w-0"
        >
          {children}
        </div>
      </WizardPanel>
    </div>
  )
}
