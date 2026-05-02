import type { CreateAgentRequest, ListAgent, UpdateAgentRequest } from "@/lib/gateway/client"
import { primaryModels, summaryModels } from "@/data/schema"
import type { AgentWizardValues, CreateAgentFormValues, CreateAgentFormState } from "@/data/types"
import { createAgentFormSchema } from "@/data/schema"

export const defaultAgentWizardValues: AgentWizardValues = {
  identity: {
    name: "",
    systemPrompt: "",
  },
  compaction: {
    mode: "summary",
    thresholdRatio: 0.9,
    historyToolResultRatio: 0.008,
    keepRecentRequests: 2,
    oversizedToolResultRatio: 0.065,
    maxHistoryRuns: 50,
  },
  model: {
    primaryName: primaryModels[0],
    primaryContextWindow: Number.NaN,
    primaryTemperature: 0.2,
    summaryName: summaryModels[0],
    summaryContextWindow: Number.NaN,
    summaryTemperature: 0.2,
  },
  tools: {
    hostExec: true,
    webFetch: true,
    file: false,
    arxiv: false,
  },
}

export function agentFormValues(formData: FormData) {
  return {
    name: formData.get("name"),
    systemPrompt: formData.get("systemPrompt") ?? "",
    compactionMode: formData.get("compactionMode"),
    thresholdRatio: formData.get("thresholdRatio"),
    historyToolResultRatio: formData.get("historyToolResultRatio"),
    keepRecentRequests: formData.get("keepRecentRequests"),
    oversizedToolResultRatio: formData.get("oversizedToolResultRatio"),
    maxHistoryRuns: formData.get("maxHistoryRuns"),
    primaryName: formData.get("primaryName"),
    primaryContextWindow: formData.get("primaryContextWindow"),
    primaryTemperature: formData.get("primaryTemperature"),
    summaryName: formData.get("summaryName") ?? "",
    summaryContextWindow: formData.get("summaryContextWindow") ?? "0",
    summaryTemperature: formData.get("summaryTemperature") ?? "0.2",
    hostExec: formData.has("hostExec"),
    webFetch: formData.has("webFetch"),
    file: formData.has("file"),
    arxiv: formData.has("arxiv"),
  }
}

export function createAgentRequest(data: CreateAgentFormValues): CreateAgentRequest {
  return {
    name: data.name,
    ...agentConfigurationRequest(data),
  }
}

export function updateAgentRequest(data: CreateAgentFormValues): UpdateAgentRequest {
  return agentConfigurationRequest(data)
}

export function agentWizardValues(agent: ListAgent): AgentWizardValues {
  const config = agent.configuration
  const defaults = defaultAgentWizardValues
  const compaction = config.compaction
  const primary = config.model.primary
  const summary = config.model.summary
  const tools = config.tools

  return {
    identity: {
      name: agent.name,
      systemPrompt: config.systemPrompt ?? defaults.identity.systemPrompt,
    },
    compaction: {
      mode: compaction?.mode ?? defaults.compaction.mode,
      thresholdRatio: compaction?.thresholdRatio ?? defaults.compaction.thresholdRatio,
      historyToolResultRatio:
        compaction?.historyToolResultRatio ?? defaults.compaction.historyToolResultRatio,
      keepRecentRequests: compaction?.keepRecentRequests ?? defaults.compaction.keepRecentRequests,
      oversizedToolResultRatio:
        compaction?.oversizedToolResultRatio ?? defaults.compaction.oversizedToolResultRatio,
      maxHistoryRuns: config.maxHistoryRuns ?? defaults.compaction.maxHistoryRuns,
    },
    model: {
      primaryName: primary.name,
      primaryContextWindow: primary.contextWindow,
      primaryTemperature: primary.temperature ?? defaults.model.primaryTemperature,
      summaryName: summary?.name ?? defaults.model.summaryName,
      summaryContextWindow: summary?.contextWindow ?? defaults.model.summaryContextWindow,
      summaryTemperature: summary?.temperature ?? defaults.model.summaryTemperature,
    },
    tools: {
      hostExec: tools?.hostExec?.enabled ?? defaults.tools.hostExec,
      webFetch: tools?.webFetch?.enabled ?? defaults.tools.webFetch,
      file: tools?.file?.enabled ?? defaults.tools.file,
      arxiv: tools?.arxiv?.enabled ?? defaults.tools.arxiv,
    },
  }
}

function agentConfigurationRequest(data: CreateAgentFormValues): Omit<CreateAgentRequest, "name"> {
  const body: Omit<CreateAgentRequest, "name"> = {
    systemPrompt: data.systemPrompt,
    compaction: {
      mode: data.compactionMode,
      thresholdRatio: data.thresholdRatio,
      historyToolResultRatio: data.historyToolResultRatio,
      keepRecentRequests: data.keepRecentRequests,
      oversizedToolResultRatio: data.oversizedToolResultRatio,
    },
    maxHistoryRuns: data.maxHistoryRuns,
    model: {
      primary: {
        name: data.primaryName,
        contextWindow: data.primaryContextWindow,
        temperature: data.primaryTemperature,
      },
    },
    tools: {
      hostExec: { enabled: data.hostExec },
      webFetch: { enabled: data.webFetch },
      file: { enabled: data.file },
      arxiv: { enabled: data.arxiv },
    },
  }
  if (data.compactionMode === "summary") {
    body.model.summary = {
      name: data.summaryName,
      contextWindow: data.summaryContextWindow,
      temperature: data.summaryTemperature,
    }
  }
  return body
}

type ParsedAgentForm =
  | {
      data: CreateAgentFormValues
      state: undefined
    }
  | {
      data: undefined
      state: CreateAgentFormState
    }

export function parseAgentForm(formData: FormData): ParsedAgentForm {
  const parsed = createAgentFormSchema.safeParse(agentFormValues(formData))
  if (parsed.success) {
    return { data: parsed.data, state: undefined }
  }

  return {
    data: undefined,
    state: {
      error: {
        code: "INVALID_FORM",
        message: "Agent configuration is invalid",
        errors: parsed.error.issues.map((issue) => {
          return {
            field: issue.path.join("."),
            message: issue.message,
          }
        }),
      },
    },
  }
}
