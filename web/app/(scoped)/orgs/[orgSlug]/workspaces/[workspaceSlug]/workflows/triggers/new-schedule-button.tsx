"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import type { WorkflowSummary } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import { DisabledReason } from "@/components/ui/tooltip"
import type { CreateWorkflowScheduleFormState, WorkflowInputContractResult } from "@/data/types"
import { ScheduleSheet } from "./schedule-sheet"

export function NewScheduleButton({
  agentName,
  workflows,
  createWorkflowScheduleAction,
  getWorkflowInputContractAction,
}: {
  agentName: string
  workflows: WorkflowSummary[]
  createWorkflowScheduleAction: (
    agentName: string,
    state: CreateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<CreateWorkflowScheduleFormState>
  getWorkflowInputContractAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputContractResult>
}) {
  const [open, setOpen] = React.useState(false)
  const disabled = workflows.length === 0
  const button = (
    <Button onClick={() => setOpen(true)} disabled={disabled}>
      <Plus data-icon="inline-start" />
      New schedule
    </Button>
  )

  return (
    <>
      {disabled ? (
        <DisabledReason reason="Create a workflow for this agent before adding a schedule.">
          {button}
        </DisabledReason>
      ) : (
        button
      )}
      <ScheduleSheet
        agentName={agentName}
        mode="create"
        workflows={workflows}
        createWorkflowScheduleAction={createWorkflowScheduleAction}
        getWorkflowInputContractAction={getWorkflowInputContractAction}
        open={open}
        onOpenChangeAction={setOpen}
      />
    </>
  )
}
