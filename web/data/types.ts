import type { Agent, Environment, Error } from "@/lib/gateway/client"

export type ListAgentActionResponse<TAgent = Agent> =
  | {
      agents: TAgent[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      agents: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export type AgentSessionListItem = {
  id: string
  title: string
  updatedAt: number
  parentID?: string
}

export type ListAgentSessionActionResponse =
  | {
      sessions: AgentSessionListItem[]
      error: undefined
    }
  | {
      sessions: undefined
      error: Error
    }

export type TraceListItem = {
  agentName: string
  sessionId: string
  traceId: string
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

export type TraceSessionFilterItem = {
  sessionId: string
  title: string
}

export type TraceSessionFilterActionResponse =
  | {
      data: TraceSessionFilterItem[]
      error: undefined
    }
  | {
      data: undefined
      error: Error
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

export type RuntimeTelemetryTab = "process" | "file" | "network"

export type RuntimeTelemetryTabActionData = {
  events: RuntimeTelemetryEventItem[]
  nextPageToken: string
  hasNextPage: boolean
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

export type RuntimeTelemetryTabActionResponse =
  | {
      data: RuntimeTelemetryTabActionData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type ProcessTelemetryRow = {
  process: string
  command: string
  action: string
  occurrences: number
  lastSeen: string
}

export type FileTelemetryRow = {
  filePath: string
  process: string
  action: string
  occurrences: number
  lastSeen: string
}

export type NetworkTelemetryRow = {
  destinationDomain: string
  destinationIP: string
  destinationPort: number
  protocol: string
  action: string
  occurrences: number
  lastSeen: string
}

export type ProcessTelemetryActionData = {
  rows: ProcessTelemetryRow[]
  chart: TraceChartActionData
  nextPageToken: string
  hasNextPage: boolean
}

export type FileTelemetryActionData = {
  rows: FileTelemetryRow[]
  chart: TraceChartActionData
  nextPageToken: string
  hasNextPage: boolean
}

export type NetworkTelemetryActionData = {
  rows: NetworkTelemetryRow[]
  chart: TraceChartActionData
  nextPageToken: string
  hasNextPage: boolean
}

export type ProcessTelemetryActionResponse =
  | { data: ProcessTelemetryActionData; error: undefined }
  | { data: undefined; error: Error }

export type FileTelemetryActionResponse =
  | { data: FileTelemetryActionData; error: undefined }
  | { data: undefined; error: Error }

export type NetworkTelemetryActionResponse =
  | { data: NetworkTelemetryActionData; error: undefined }
  | { data: undefined; error: Error }

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
  agentName: string
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
  spanClass: string
  kind: string
  statusCode: string
  llmFinishReason: string
  hasError: boolean
  error: string
  spanType: "agent" | "model" | "tool" | "span"
  depth: number
  inputTokens: number
  cachedInputTokens: number
  cachedWriteTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number
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
  resourceAttributes: SpanDetailPayloadSection
  spanAttributes: SpanDetailPayloadSection
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

export type ListEnvironmentActionResponse =
  | {
      environments: Environment[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      environments: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export type DeleteEnvironmentFormState = {
  error?: Error
}

export type CreateEnvironmentFormState = {
  error?: Error
}

export type PutSecretFormState = {
  error?: Error
}

export type DeleteSecretFormState = {
  error?: Error
}

export type DeleteSessionFormState = {
  error?: Error
  success?: boolean
}

export type ProviderModelItem = {
  chef: string
  chefSlug: string
  contextLimit?: number
  id: string
  modelID: string
  name: string
  providerID: string
  variants?: string[]
}

export type ListAgentProvidersActionResponse =
  | {
      models: ProviderModelItem[]
      chefs: string[]
      error: undefined
    }
  | {
      models: undefined
      chefs: undefined
      error: Error
    }
