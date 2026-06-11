"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import { createWorkflowRun, deleteWorkflowRun, type Error } from "@/lib/gateway/client"
import { scheduleWorkflowRunsTag, workflowRunsTag } from "@/data/cache"
import { gatewayServerClient } from "@/lib/gateway/server-client"

export type DeleteWorkflowRunActionState = {
  success: boolean
  error?: Error
}

export type TriggerWorkflowRunActionState = {
  success: boolean
  error?: Error
}

/**
 * deleteWorkflowRunAction deletes one workflow run for the selected schedule.
 */
export async function deleteWorkflowRunAction(
  agentName: string,
  scheduleName: string,
  _: DeleteWorkflowRunActionState,
  formData: FormData
): Promise<DeleteWorkflowRunActionState> {
  const runName = formData.get("run_name")
  if (typeof runName !== "string" || runName.length === 0) {
    return {
      success: false,
      error: {
        code: "INVALID_FORM",
        message: "Invalid workflow run name",
      },
    }
  }

  const result = await deleteWorkflowRun({
    client: gatewayServerClient,
    path: {
      agentName,
      name: scheduleName,
      runName,
    },
  })
  if (result.error) {
    return {
      success: false,
      error: result.error,
    }
  }

  updateTag(workflowRunsTag)
  updateTag(scheduleWorkflowRunsTag(agentName, scheduleName))

  return {
    success: true,
    error: undefined,
  }
}

/**
 * triggerWorkflowRunAction triggers one immediate run for the selected schedule.
 */
export async function triggerWorkflowRunAction(
  agentName: string,
  scheduleName: string,
  _: TriggerWorkflowRunActionState,
  formData: FormData
): Promise<TriggerWorkflowRunActionState> {
  const submittedScheduleName = formData.get("schedule_name")
  if (submittedScheduleName !== scheduleName) {
    return {
      success: false,
      error: {
        code: "INVALID_FORM",
        message: "Invalid workflow schedule name",
      },
    }
  }

  const result = await createWorkflowRun({
    client: gatewayServerClient,
    path: {
      agentName,
      name: scheduleName,
    },
  })
  if (result.error) {
    return {
      success: false,
      error: result.error,
    }
  }

  updateTag(workflowRunsTag)
  updateTag(scheduleWorkflowRunsTag(agentName, scheduleName))
  redirect(
    `/workflows/schedules/${encodeURIComponent(agentName)}/${encodeURIComponent(scheduleName)}/runs`
  )
}
