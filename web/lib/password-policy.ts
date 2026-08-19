import { z } from "zod"

export const minPasswordLength = 12

export const passwordFieldDescription =
  "Use at least 12 characters, including uppercase, lowercase, a number, and a symbol."

export const passwordSchema = z.string().check(
  z.minLength(minPasswordLength, {
    error: `Use at least ${minPasswordLength} characters.`,
  }),
  z.regex(/[a-z]/, {
    error: "Add at least one lowercase letter.",
  }),
  z.regex(/[A-Z]/, {
    error: "Add at least one uppercase letter.",
  }),
  z.regex(/[0-9]/, {
    error: "Add at least one number.",
  }),
  z.regex(/[^A-Za-z0-9]/, {
    error: "Add at least one symbol.",
  })
)
