import type { Edge, Node, ReactFlowProps } from "@xyflow/react"
import { Background, ReactFlow } from "@xyflow/react"
import type { ReactNode } from "react"

import "@xyflow/react/dist/style.css"

type CanvasProps<NodeType extends Node = Node, EdgeType extends Edge = Edge> = ReactFlowProps<
  NodeType,
  EdgeType
> & {
  children?: ReactNode
}

const deleteKeyCode = ["Backspace", "Delete"]
const reactFlowProOptions = { hideAttribution: true } as const

export const Canvas = <NodeType extends Node = Node, EdgeType extends Edge = Edge>({
  children,
  ...props
}: CanvasProps<NodeType, EdgeType>) => (
  <ReactFlow
    deleteKeyCode={deleteKeyCode}
    fitView
    panOnDrag
    panOnScroll
    proOptions={reactFlowProOptions}
    selectionOnDrag={false}
    zoomOnDoubleClick={false}
    {...props}
  >
    <Background bgColor="var(--sidebar)" />
    {children}
  </ReactFlow>
)
