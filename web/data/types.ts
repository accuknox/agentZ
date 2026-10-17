import type {
  LensApp,
  Agent,
  Sandbox,
  Error,
  McpGraphResponse,
  AppMcpGraphResponse,
  SecretWarning,
  WorkflowArbitraryJson,
  WorkflowInputs,
  ProcessObservabilityEvent,
  FileObservabilityEvent,
  NetworkObservabilityEvent,
} from "@/lib/gateway/client"

export type WorkspacePath = `/orgs/${string}/workspaces/${string}`

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

export type LensSubject =
  | { kind: "agent"; name: string; sessionId?: string }
  | { kind: "app"; clientID: string; name: string }
  | {
      kind: "external-agent"
      clientID: string
      name: string
      providerKind: NonNullable<LensApp["agent_kind"]>
      sessionId?: string
    }

export type TraceSubject =
  | { kind: "agent"; name: string; sessionId: string }
  | Extract<LensSubject, { kind: "app" | "external-agent" }>

export type TraceListItem = {
  subject: TraceSubject
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
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
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

export type RuntimeTelemetryTab = "process" | "file" | "network"

export type RuntimeTelemetryTabActionData = {
  nextPageToken: string
  hasNextPage: boolean
} & (
  | { tab: "process"; events: ProcessObservabilityEvent[] }
  | { tab: "file"; events: FileObservabilityEvent[] }
  | { tab: "network"; events: NetworkObservabilityEvent[] }
)

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
  chart: EventsChartData
  nextPageToken: string
  hasNextPage: boolean
}

export type FileTelemetryActionData = {
  rows: FileTelemetryRow[]
  chart: EventsChartData
  nextPageToken: string
  hasNextPage: boolean
}

export type NetworkTelemetryActionData = {
  rows: NetworkTelemetryRow[]
  chart: EventsChartData
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

export type EventsChartPoint = {
  label: string
  count: number
}

export type EventsChartData = {
  points: EventsChartPoint[]
  total: number
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

export type EventsChartActionResponse =
  | {
      data: EventsChartData
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type McpGraphActionResponse =
  | {
      data: McpGraphResponse | AppMcpGraphResponse
      error: undefined
    }
  | {
      data: undefined
      error: Error
    }

export type SpanListItem = {
  id: number
  subject: TraceSubject
  traceId: string
  spanId: string
  parentSpanId: string
  startLabel: string
  endLabel: string
  duration: string | undefined
  durationMs: number | null
  displayName: string
  spanClass: string
  kind: string
  statusCode: string
  llmFinishReason?: string
  hasError: boolean
  error: string
  spanType: "agent" | "model" | "tool" | "span"
  depth: number
  inputTokens: number | null
  cachedInputTokens: number | null
  cachedWriteTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
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
  content: { code: string } | { text: string }
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
  success?: boolean
}

export type DeleteAgentFormState = {
  error?: Error
  success?: boolean
}

export type ListSandboxActionResponse =
  | {
      sandboxes: Sandbox[]
      nextPageToken: string
      hasNextPage: boolean
      error: undefined
    }
  | {
      sandboxes: undefined
      nextPageToken?: undefined
      hasNextPage?: undefined
      error: Error
    }

export type DeleteSandboxFormState = {
  error?: Error
  success?: boolean
}

export type CreateSandboxFormState = {
  error?: Error
  success?: boolean
}

export type PutSecretFormState = {
  error?: Error
  success?: boolean
  warning?: SecretWarning
  status?: "oauth_pending"
  oauth?: {
    flowId: string
    url: string
  }
}

export type DeleteSecretFormState = {
  error?: Error
  success?: boolean
}

export type PutSecretFormAction = (
  agentName: string,
  state: PutSecretFormState,
  formData: FormData
) => Promise<PutSecretFormState>

export type DeleteSecretFormAction = (
  agentName: string,
  state: DeleteSecretFormState,
  formData: FormData
) => Promise<DeleteSecretFormState>

export type DeleteSessionFormState = {
  error?: Error
  success?: boolean
}

export type CreateAPIKeyFormState = {
  error?: Error
  key?: {
    id: string
    name: string | null
    secret: string
  }
}

export type DeleteAPIKeyFormState = {
  error?: Error
  success?: boolean
}

export type CreateWorkflowScheduleFormState = {
  error?: Error
  success?: boolean
}

export type UpdateWorkflowScheduleFormState = {
  error?: Error
  success?: boolean
}

export type DeleteWorkflowScheduleFormState = {
  error?: Error
  success?: boolean
}

export type WorkflowInputContractResult =
  | {
      ok: true
      inputs: WorkflowInputs
      arbitrary_json?: WorkflowArbitraryJson
    }
  | {
      ok: false
      error: Error
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

export type WorkflowActionScope = {
  basePath: string
  workspaceId: string
}
