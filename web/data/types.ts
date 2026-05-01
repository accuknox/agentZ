import type * as z from "zod"
import type { Agent, Error } from "@/lib/gateway/client"
import type {
  compactionSchema,
  createAgentFormSchema,
  identitySchema,
  modelSchema,
  toolsSchema,
} from "@/data/schema"

export type Identity = z.infer<typeof identitySchema>
export type Compaction = z.infer<typeof compactionSchema>
export type Model = z.infer<typeof modelSchema>
export type Tools = z.infer<typeof toolsSchema>
export type CreateAgentFormValues = z.infer<typeof createAgentFormSchema>

export type ListAgentActionResponse =
  | {
      agents: Agent[]
      error: undefined
    }
  | {
      agents: undefined
      error: Error
    }

export type CreateAgentFormState = {
  error?: Error
}
