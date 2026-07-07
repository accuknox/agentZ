import * as z from "zod"

const apiKeyTypeSchema = z.enum(["agent", "webhook"], {
  error: "Select an API key type.",
})
const apiKeyExpirySchema = z.enum(["none", "7", "30", "90", "365"], {
  error: "Select an API key expiry.",
})
const apiKeyScopeModeSchema = z.enum(["all", "selected"], {
  error: "Select an API key scope.",
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
    scopeMode: apiKeyScopeModeSchema,
    agentNames: z
      .array(
        z.string({ error: "Agent name is required" }).trim().min(1, "Agent name is required"),
        {
          error: "Selected agents must be a list.",
        }
      )
      .max(200, "Select at most 200 agents."),
    workflowScopes: z
      .array(
        z
          .string({ error: "Workflow selection is required" })
          .trim()
          .min(1, "Workflow selection is required"),
        {
          error: "Selected workflows must be a list.",
        }
      )
      .max(500, "Select at most 500 workflows."),
  })
  .superRefine((value, ctx) => {
    if (value.type === "agent") {
      if (value.scopeMode !== "selected" || value.agentNames.length > 0) {
        return
      }

      ctx.addIssue({
        code: "custom",
        message: "Select at least one agent.",
        path: ["agentNames"],
      })
      return
    }

    if (value.scopeMode !== "selected" || value.workflowScopes.length > 0) {
      return
    }

    ctx.addIssue({
      code: "custom",
      message: "Select at least one workflow.",
      path: ["workflowScopes"],
    })
  })

export type CreateAPIKeyFormValues = z.infer<typeof createAPIKeyFormSchema>
