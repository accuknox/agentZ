import * as z from "zod"

const apiKeyTypeSchema = z.enum(["agent", "webhook"])
const apiKeyExpirySchema = z.enum(["none", "7", "30", "90", "365"])
const apiKeyScopeModeSchema = z.enum(["all", "selected"])

export const createAPIKeyFormSchema = z
  .object({
    type: apiKeyTypeSchema,
    name: z
      .string()
      .trim()
      .min(1, "Name is required")
      .max(32, "Name must be at most 32 characters"),
    expiresInDays: apiKeyExpirySchema,
    scopeMode: apiKeyScopeModeSchema,
    agentNames: z.array(z.string().trim().min(1)).max(200),
    workflowScopes: z.array(z.string().trim().min(1)).max(500),
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
