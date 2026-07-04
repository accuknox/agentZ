"use server"

import { redirect } from "next/navigation"
import { updateTag } from "next/cache"
import * as z from "zod"
import { createWorkflowRun, deleteWorkflowRun, type Error } from "@/lib/gateway/client"
import { workflowRunsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type DeleteWorkflowRunActionState = {
  success: boolean
  error?: Error
}

export type TriggerWorkflowRunActionState = {
  success: boolean
  error?: Error
}

const deleteWorkflowRunFormSchema = z.object({
  run_name: z.string().min(1),
})

const triggerWorkflowRunFormSchema = z.object({
  schedule_name: z.string().min(1),
})

/**
 * deleteWorkflowRunAction deletes one workflow run for one workflow.
 */
export async function deleteWorkflowRunAction(
  agentName: string,
  workflowName: string,
  _: DeleteWorkflowRunActionState,
  formData: FormData
): Promise<DeleteWorkflowRunActionState> {
  const parsed = deleteWorkflowRunFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: "INVALID_FORM",
        message: "Invalid workflow run name",
      },
    }
  }

  const result = await deleteWorkflowRun({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName,
      runName: parsed.data.run_name,
    },
  })
  if (result.error) {
    return {
      success: false,
      error: result.error,
    }
  }

  updateTag(workflowRunsTag)

  return {
    success: true,
    error: undefined,
  }
}

/**
 * triggerWorkflowRunAction triggers one immediate run for one workflow schedule.
 */
export async function triggerWorkflowRunAction(
  agentName: string,
  workflowName: string,
  scheduleName: string,
  _: TriggerWorkflowRunActionState,
  formData: FormData
): Promise<TriggerWorkflowRunActionState> {
  const parsed = triggerWorkflowRunFormSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success || parsed.data.schedule_name !== scheduleName) {
    return {
      success: false,
      error: {
        code: "INVALID_FORM",
        message: "Invalid workflow schedule name",
      },
    }
  }

  const result = await createWorkflowRun({
    client: getGatewayServerClient(),
    path: {
      agentName,
      workflowName,
      scheduleName,
    },
  })
  if (result.error) {
    return {
      success: false,
      error: result.error,
    }
  }

  updateTag(workflowRunsTag)
  redirect(
    `/workflows/triggers/runs?agent_name=${encodeURIComponent(agentName)}&type=schedule&workflow_name=${encodeURIComponent(workflowName)}&schedule_name=${encodeURIComponent(scheduleName)}`
  )
}
