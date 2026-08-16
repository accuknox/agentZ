import { z } from "zod"

export const workflowFiltersFormSchema = z.object({
  agent_name: z.string({ error: "Select an agent." }).min(1, "Select an agent."),
  workflow_name: z.string({ error: "Workflow name must be text." }).default(""),
})

export type WorkflowFiltersFormInput = z.input<typeof workflowFiltersFormSchema>
export type WorkflowFiltersFormValues = z.infer<typeof workflowFiltersFormSchema>

const workflowTriggerTypeSchema = z.enum(["schedule", "webhook"], {
  error: "Select a trigger type.",
})

export const workflowTriggerFiltersFormSchema = z.object({
  agent_name: z.string({ error: "Select an agent." }).min(1, "Select an agent."),
  type: workflowTriggerTypeSchema,
})

export type WorkflowTriggerFiltersFormValues = z.infer<typeof workflowTriggerFiltersFormSchema>

export const workflowRunFiltersFormSchema = z.object({
  agent_name: z.string({ error: "Select an agent." }).min(1, "Select an agent."),
  type: workflowTriggerTypeSchema,
  workflow_name: z.string({ error: "Workflow name must be text." }).default(""),
  schedule_name: z.string({ error: "Schedule name must be text." }).default(""),
  webhook_api_key_id: z.string({ error: "Webhook API key must be text." }).default(""),
})

export type WorkflowRunFiltersFormInput = z.input<typeof workflowRunFiltersFormSchema>
export type WorkflowRunFiltersFormValues = z.infer<typeof workflowRunFiltersFormSchema>

export const workflowRunGraphFiltersFormSchema = z.object({
  agent_name: z.string({ error: "Select an agent." }).min(1, "Select an agent."),
  workflow_name: z.string({ error: "Workflow name must be text." }).default(""),
  run_name: z.string({ error: "Run name must be text." }).default(""),
})

export type WorkflowRunGraphFiltersFormInput = z.input<typeof workflowRunGraphFiltersFormSchema>
export type WorkflowRunGraphFiltersFormValues = z.infer<typeof workflowRunGraphFiltersFormSchema>
