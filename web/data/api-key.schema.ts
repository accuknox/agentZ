import * as z from "zod"

const apiKeyTypeSchema = z.enum(["agent", "webhook"], {
  error: "Select an API key type.",
})
const apiKeyExpirySchema = z.enum(["none", "7", "30", "90", "365"], {
  error: "Select an API key expiry.",
})
export const createAPIKeyFormSchema = z
  .object({
    type: apiKeyTypeSchema,
    name: z
      .string({ error: "Name is required" })
      .trim()
      .min(1, "Name is required")
      .max(32, "Name must be at most 32 characters"),
    expiresInDays: apiKeyExpirySchema,
    agentNames: z
      .array(
        z.string({ error: "Agent name is required" }).trim().min(1, "Agent name is required"),
        {
          error: "Selected agents must be a list.",
        }
      )
      .max(200, "Select at most 200 agents."),
    workflowAgentNames: z
      .array(
        z
          .string({ error: "Workflow Agent is required" })
          .trim()
          .min(1, "Workflow Agent is required"),
        {
          error: "Workflow Agents must be a list.",
        }
      )
      .max(500, "Select at most 500 workflows."),
    workflowNames: z
      .array(
        z.string({ error: "Workflow name is required" }).trim().min(1, "Workflow name is required"),
        {
          error: "Workflow names must be a list.",
        }
      )
      .max(500, "Select at most 500 workflows."),
  })
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (value.agentNames.length > 0) {
        return
      }

      ctx.addIssue({
        code: "custom",
        message: "Select at least one agent.",
        path: ["agentNames"],
      })
      return
    }

    if (value.workflowNames.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Select at least one workflow.",
        path: ["workflowNames"],
      })
    }
    if (value.workflowNames.length !== value.workflowAgentNames.length) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid workflow selection.",
        path: ["workflowNames"],
      })
    }
  })

export type CreateAPIKeyFormValues = z.infer<typeof createAPIKeyFormSchema>
