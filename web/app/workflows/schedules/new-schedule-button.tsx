"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import type { WorkflowSummary } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import type { CreateWorkflowScheduleFormState, WorkflowInputSchemaResult } from "@/data/types"
import { ScheduleSheet } from "./schedule-sheet"

export function NewScheduleButton({
  agentName,
  workflows,
  createWorkflowScheduleAction,
  getWorkflowInputSchemaAction,
}: {
  agentName: string
  workflows: WorkflowSummary[]
  createWorkflowScheduleAction: (
    agentName: string,
    state: CreateWorkflowScheduleFormState,
    formData: FormData
  ) => Promise<CreateWorkflowScheduleFormState>
  getWorkflowInputSchemaAction: (
    agentName: string,
    workflowName: string
  ) => Promise<WorkflowInputSchemaResult>
}) {
  const [open, setOpen] = React.useState(false)
  const disabled = workflows.length === 0

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? "Create a workflow for this agent before adding a schedule" : undefined}
      >
        <Plus data-icon="inline-start" />
        New schedule
      </Button>
      <ScheduleSheet
        agentName={agentName}
        mode="create"
        workflows={workflows}
        createWorkflowScheduleAction={createWorkflowScheduleAction}
        getWorkflowInputSchemaAction={getWorkflowInputSchemaAction}
        open={open}
        onOpenChangeAction={setOpen}
      />
    </>
  )
}
