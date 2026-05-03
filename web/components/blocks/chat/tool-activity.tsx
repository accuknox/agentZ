import type { ReactNode } from "react"
import { getToolTarget, getToolVerb } from "./tool-payload"
import type { ChatTool } from "./types"

export function ToolActivity({ tool }: { tool: ChatTool }): ReactNode {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-sm leading-6 text-muted-foreground">
      <span className="shrink-0 text-muted-foreground/80">~</span>
      <span className="shrink-0">{getToolVerb(tool)}</span>
      <span className="truncate text-muted-foreground/70">{getToolTarget(tool)}</span>
      {tool.errorText ? (
        <span className="min-w-0 truncate text-chat-error">{tool.errorText}</span>
      ) : null}
    </div>
  )
}
