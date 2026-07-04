import * as z from "zod"

export const searchParamStringSchema = z
  .union([z.string(), z.array(z.string()).transform((values) => values[0])])
  .optional()

export type SearchParamStringInput = z.input<typeof searchParamStringSchema>
