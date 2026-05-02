import type { ChatTool, ChatToolState, KnownToolName } from "./types"

type HostExecCommandInput = {
  command: string
}

type HostExecWriteStdinInput = {
  chars: string
}

type WebFetchInput = {
  urls: string[]
}

type ToolErrorOutput = {
  error: unknown
}

export function parseToolPayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown
  } catch {
    return payload
  }
}

export function getToolVerb(tool: ChatTool): string {
  const done = tool.state === "output-available" || tool.state === "output-error"

  switch (tool.name) {
    case "web_fetch":
      return done ? "Searched" : "Searching"
    case "hostexec_exec_command":
      return done ? "Ran" : "Running"
    case "hostexec_write_stdin":
      return done ? "Interacted" : "Interacting"
    default:
      return done ? "Used" : "Using"
  }
}

export function getToolTarget(tool: ChatTool): string {
  if (isKnownToolName(tool.name)) {
    return getKnownToolTarget(tool.name, tool.input) ?? tool.name
  }

  return tool.name
}

export function getToolResultState(output: unknown): ChatToolState {
  return isToolErrorOutput(output) ? "output-error" : "output-available"
}

export function getToolErrorText(output: unknown): string | undefined {
  if (!isToolErrorOutput(output)) {
    return undefined
  }

  return String(output.error)
}

function getKnownToolTarget(name: KnownToolName, input: unknown): string | undefined {
  switch (name) {
    case "hostexec_exec_command":
      return isHostExecCommandInput(input) ? input.command : undefined
    case "hostexec_write_stdin":
      return isHostExecWriteStdinInput(input) ? input.chars : undefined
    case "web_fetch":
      return isWebFetchInput(input) ? input.urls.join(", ") : undefined
  }
}

function isKnownToolName(name: string): name is KnownToolName {
  return name === "hostexec_exec_command" || name === "hostexec_write_stdin" || name === "web_fetch"
}

function isHostExecCommandInput(input: unknown): input is HostExecCommandInput {
  return isRecord(input) && typeof input.command === "string"
}

function isHostExecWriteStdinInput(input: unknown): input is HostExecWriteStdinInput {
  return isRecord(input) && typeof input.chars === "string"
}

function isWebFetchInput(input: unknown): input is WebFetchInput {
  return (
    isRecord(input) &&
    Array.isArray(input.urls) &&
    input.urls.every((url): url is string => typeof url === "string")
  )
}

function isToolErrorOutput(output: unknown): output is ToolErrorOutput {
  return isRecord(output) && "error" in output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object")
}
