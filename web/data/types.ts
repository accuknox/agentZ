import type * as z from "zod"
import type { Agent, ChatHistoryResponse, Error, ListAgent } from "@/lib/gateway/client"
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

export type AgentWizardValues = {
  identity: Identity
  compaction: Compaction
  model: Model
  tools: Tools
}

export type ListAgentActionResponse<TAgent = Agent> =
  | {
      agents: TAgent[]
      error: undefined
    }
  | {
      agents: undefined
      error: Error
    }

export type ListAgentWithConfigActionResponse = ListAgentActionResponse<ListAgent>

export type ChatHistoryActionResponse =
  | {
      data: ChatHistoryResponse
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type TraceListItem = {
  traceId: string
  sessionId: string
  startedAt: string
  endedAt: string
  startedDate: string
  startedTime: string
  endedTime: string
  duration: string
  durationMs: number
  cumulativeDurationMs: number
  cumulativeDurationPercent: number
  waterfallDelayMs: number
  spanCount: number
  errorCount: number
  toolCount: number
  modelCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokenRatio: number
}

export type ListTracesActionData = {
  traces: TraceListItem[]
  nextPageToken: string
  hasNextPage: boolean
  limit: number
}

export type RuntimeTelemetryEventItem = {
  id: number
  kind: "process" | "file" | "network"
  eventTime: string
  time: string
  action: string
  primary: string
  secondary: string
  source: string
  namespace: string
  pod: string
}

export type RuntimeTelemetryActionData = {
  events: RuntimeTelemetryEventItem[]
  processCount: number
  fileCount: number
  networkCount: number
  blockedCount: number
}

export type RuntimeTelemetryActionResponse =
  | {
      data: RuntimeTelemetryActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type TraceChartPoint = {
  label: string
  count: number
  startedAfter: string
  startedBefore: string
}

export type TraceChartActionData = {
  points: TraceChartPoint[]
  total: number
  granularity: string
}

export type ListTracesActionResponse =
  | {
      data: ListTracesActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type TraceChartActionResponse =
  | {
      data: TraceChartActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type SpanListItem = {
  id: number
  sessionId: string
  traceId: string
  spanId: string
  parentSpanId: string
  startLabel: string
  endLabel: string
  duration: string
  durationMs: number
  displayName: string
  operationLabel: string
  hasError: boolean
  error: string
  timeToFirstToken: string
  spanType: "agent" | "model" | "tool" | "span"
  depth: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
  offsetPercent: number
  durationPercent: number
}

export type ListSpansActionData = {
  spans: SpanListItem[]
  nextPageToken: string
  hasNextPage: boolean
}

export type ListSpansActionResponse =
  | {
      data: ListSpansActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type SpanDetailPayloadSection = {
  key: string
  label: string
  preview: string
  json: string
  empty: boolean
}

export type SpanDetailActionData = {
  span: SpanListItem
  payload: SpanDetailPayloadSection[]
}

export type SpanDetailActionResponse =
  | {
      data: SpanDetailActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type CreateAgentFormState = {
  error?: Error
}

export type DeleteAgentFormState = {
  error?: Error
}
