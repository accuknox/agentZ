import type { CreateAgentRequest } from "@/lib/gateway/client"
import type { CreateAgentFormValues } from "@/data/types"

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
  const body: CreateAgentRequest = {
    name: data.name,
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
