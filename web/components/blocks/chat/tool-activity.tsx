import type { ReactNode } from "react"
import { getToolTarget, getToolVerb } from "./tool-payload"
import type { ChatTool } from "./types"

export function ToolActivity({ tool }: { tool: ChatTool }): ReactNode {
  return (
    <div className="flex min-w-0 text-sm">
      <span className="shrink-0 text-foreground">{getToolVerb(tool)}&nbsp;</span>
      <span className="truncate text-muted-foreground">{getToolTarget(tool)}</span>
    </div>
  )
}
