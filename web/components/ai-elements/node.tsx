import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Handle, Position } from "@xyflow/react"
import type { ComponentProps } from "react"

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean
    source: boolean
  }
}

export const Node = ({ handles, className, ...props }: NodeProps) => (
  <Card
    className={cn("node-container relative size-full h-auto w-sm gap-0 rounded-md p-0", className)}
    {...props}
  >
    {handles.target && <Handle position={Position.Left} type="target" />}
    {handles.source && <Handle position={Position.Right} type="source" />}
    {props.children}
  </Card>
)

export type NodeContentProps = ComponentProps<typeof CardContent>

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  <CardContent className={cn("p-3", className)} {...props} />
)
