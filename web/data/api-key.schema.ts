import * as z from "zod"

export const apiKeyExpirySchema = z.enum(["none", "7", "30", "90", "365"])

export const apiKeyScopeModeSchema = z.enum(["all", "selected"])

export const createAPIKeyFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required")
      .max(32, "Name must be at most 32 characters"),
    expiresInDays: apiKeyExpirySchema,
    scopeMode: apiKeyScopeModeSchema,
    agentNames: z.array(z.string().trim().min(1)).max(200),
  })
  .superRefine((value, ctx) => {
    if (value.scopeMode !== "selected" || value.agentNames.length > 0) {
      return
    }

    ctx.addIssue({
      code: "custom",
      message: "Select at least one agent.",
      path: ["agentNames"],
    })
  })

export type CreateAPIKeyFormValues = z.infer<typeof createAPIKeyFormSchema>
