import { z } from "zod"

export const workflowFiltersFormSchema = z.object({
  agent_name: z.string().min(1),
  workflow_name: z.string(),
})

export type WorkflowFiltersFormValues = z.infer<typeof workflowFiltersFormSchema>

export const workflowTriggerTypeSchema = z.enum(["schedule", "webhook"])

export const workflowTriggerFiltersFormSchema = z.object({
  agent_name: z.string().min(1),
  type: workflowTriggerTypeSchema,
})

export type WorkflowTriggerFiltersFormValues = z.infer<typeof workflowTriggerFiltersFormSchema>

export const workflowRunFiltersFormSchema = z.object({
  agent_name: z.string().min(1),
  type: workflowTriggerTypeSchema,
  workflow_name: z.string(),
  schedule_name: z.string(),
  webhook_api_key_id: z.string(),
})

export type WorkflowRunFiltersFormValues = z.infer<typeof workflowRunFiltersFormSchema>
