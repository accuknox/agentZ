import { z } from "zod"

export const workflowFiltersFormSchema = z.object({
  agent_name: z.string().min(1),
  workflow_name: z.string(),
})

export type WorkflowFiltersFormValues = z.infer<typeof workflowFiltersFormSchema>
