"use client"

import { WizardPanel } from "./panel"
import { WizardStepNav } from "./step-nav"
import type { WizardShellProps, WizardStep } from "./types"

export function WizardShell<TStep extends WizardStep>({
  canVisitStepAction,
  children,
  currentIndex,
  currentStepId,
  direction,
  onStepSelectAction,
  panelAdornment,
  steps,
}: WizardShellProps<TStep>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row md:gap-6">
      <WizardStepNav
        canVisitStepAction={canVisitStepAction}
        currentIndex={currentIndex}
        onStepSelectAction={onStepSelectAction}
        steps={steps}
      />
      <WizardPanel direction={direction} panelAdornment={panelAdornment} stepKey={currentStepId}>
        <div
          id={`wizard-panel-${currentStepId}`}
          role="tabpanel"
          aria-labelledby={`wizard-step-${currentStepId}`}
          tabIndex={0}
        >
          {children}
        </div>
      </WizardPanel>
    </div>
  )
}
