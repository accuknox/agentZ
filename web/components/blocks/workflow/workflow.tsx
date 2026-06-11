"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { CornerDownLeftIcon, HammerIcon, XIcon } from "lucide-react"
import {
  type EdgeTypes,
  type NodeTypes,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps as FlowNodeProps,
} from "@xyflow/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Canvas } from "@/components/ai-elements/canvas"
import { Controls } from "@/components/ai-elements/controls"
import { Edge } from "@/components/ai-elements/edge"
import {
  Node,
  NodeContent,
  NodeDescription,
  NodeFooter,
  NodeHeader,
  NodeTitle,
} from "@/components/ai-elements/node"
import { Panel } from "@/components/ai-elements/panel"
import type { Workflow as WorkflowDefinition, WorkflowNode } from "@/lib/gateway/client"

type WorkflowProps = {
  workflow: WorkflowDefinition
}

type WorkflowNodeData = {
  handles: {
    source: boolean
    target: boolean
  }
  node: WorkflowNode
}

type WorkflowCanvasNode = FlowNode<WorkflowNodeData, "workflow">

type WorkflowCanvasEdge = FlowEdge<
  {
    branchLabel: string
    conditionSummary: string
  },
  "animated" | "temporary"
>

type DagrePositionedNode = DagreNodeLabel & Required<Pick<DagreNodeLabel, "x" | "y">>

const fallbackNodeWidth = 384
const fallbackNodeHeight = 240
const nodeMarginX = 32
const nodeMarginY = 40
const rankSep = 160
const nodeSep = 112
const compactPreferredToolLimit = 3
const fitViewPadding = 0.05

const workflowEdgeTypes = {
  animated: Edge.Animated,
  temporary: Edge.Temporary,
} satisfies EdgeTypes

const workflowNodeTypes = {
  workflow: WorkflowCanvasNodeCard,
} satisfies NodeTypes

export default function Workflow({ workflow }: WorkflowProps) {
  const edges = React.useMemo(() => toCanvasEdges(workflow), [workflow])
  const initialNodes = React.useMemo(() => toCanvasNodes(workflow), [workflow])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)

  const selectedNode = React.useMemo(() => {
    return nodes.find((node) => node.id === selectedNodeId) ?? null
  }, [nodes, selectedNodeId])
  const selectedWorkflowNode = selectedNode?.data.node ?? null

  return (
    <div className="relative flex min-h-0 flex-1">
      <Canvas
        edges={edges}
        edgeTypes={workflowEdgeTypes}
        fitViewOptions={{ padding: fitViewPadding }}
        maxZoom={2}
        minZoom={0.2}
        nodes={nodes}
        nodesDraggable
        nodeTypes={workflowNodeTypes}
        onPaneClick={() => {
          setSelectedNodeId(null)
        }}
        onNodeClick={(_, node) => {
          setSelectedNodeId(node.id)
        }}
        onNodesChange={onNodesChange}
        zoomOnPinch
        zoomOnScroll
      >
        <WorkflowAutoLayout setNodes={setNodes} workflow={workflow} />
        <Controls position="bottom-left" showInteractive={false} />
        <Panel position="top-left" className="w-sm max-w-sm p-0">
          <Collapsible defaultOpen={false} className="group/workflow-summary">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted/30 focus-visible:ring-ring/60 flex w-full items-start gap-2 px-3 py-2 text-left outline-hidden transition-colors focus-visible:ring-2"
                aria-label="Toggle workflow summary"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-medium">{workflow.title}</h2>
                </div>
                <CornerDownLeftIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-2">
              <div className="flex flex-col gap-2">
                <p className="text-muted-foreground text-sm">{workflow.summary}</p>
                <p className="text-muted-foreground text-xs tracking-wide uppercase">
                  Inputs: {workflow.inputs ? Object.keys(workflow.inputs).length : 0}
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Panel>
        {selectedWorkflowNode ? (
          <Panel
            position="top-right"
            className="max-h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-4"
          >
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-sm font-medium">{selectedWorkflowNode.name}</h3>
                  <p className="text-muted-foreground text-sm">{selectedWorkflowNode.goal}</p>
                </div>
                <Button
                  aria-label="Close workflow node details"
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedNodeId(null)
                  }}
                >
                  <XIcon />
                </Button>
              </div>
              <Section title="Instructions" value={selectedWorkflowNode.instructions} />
              <Section title="Done criteria" value={selectedWorkflowNode.done_criteria} />
              <PreferredTools tools={selectedWorkflowNode.preferred_tools} />
            </div>
          </Panel>
        ) : null}
      </Canvas>
    </div>
  )
}

function WorkflowAutoLayout({
  setNodes,
  workflow,
}: {
  setNodes: ReturnType<typeof useNodesState<WorkflowCanvasNode>>[1]
  workflow: WorkflowDefinition
}) {
  const nodesInitialized = useNodesInitialized()
  const reactFlow = useReactFlow<WorkflowCanvasNode, WorkflowCanvasEdge>()
  const lastMeasuredLayoutSignatureRef = React.useRef<string | null>(null)
  const fitViewport = React.useEffectEvent(async () => {
    await reactFlow.fitView({
      duration: 200,
      maxZoom: 0.9,
      padding: fitViewPadding,
    })
  })

  React.useEffect(() => {
    lastMeasuredLayoutSignatureRef.current = null
  }, [workflow])

  React.useEffect(() => {
    if (!nodesInitialized) {
      return
    }

    const measuredNodes = reactFlow.getNodes()
    const measuredLayoutSignature = getMeasuredLayoutSignature(measuredNodes)
    if (measuredLayoutSignature === null) {
      return
    }
    if (lastMeasuredLayoutSignatureRef.current === measuredLayoutSignature) {
      return
    }

    const layoutedNodes = applyWorkflowLayout(workflow, measuredNodes)
    lastMeasuredLayoutSignatureRef.current = measuredLayoutSignature
    setNodes(layoutedNodes)
    requestAnimationFrame(() => {
      void fitViewport()
    })
  }, [nodesInitialized, reactFlow, setNodes, workflow])

  return null
}

function WorkflowCanvasNodeCard({ data, selected }: FlowNodeProps<WorkflowCanvasNode>) {
  return (
    <Node handles={data.handles} className={selected ? "ring-primary/60 ring-2" : undefined}>
      <NodeHeader>
        <NodeTitle>{data.node.name}</NodeTitle>
        <NodeDescription>{data.node.instructions}</NodeDescription>
      </NodeHeader>
      <NodeContent className="flex flex-col gap-3">
        <Section title="Goal" value={data.node.goal} clamp />
        <Section title="Done criteria" value={data.node.done_criteria} clamp />
      </NodeContent>
      <NodeFooter className="flex flex-wrap gap-2">
        <PreferredTools tools={data.node.preferred_tools} compact />
      </NodeFooter>
    </Node>
  )
}

function Section({
  title,
  value,
  clamp = false,
}: {
  title: string
  value: string
  clamp?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
      <p className={clamp ? "line-clamp-3 text-sm" : "text-sm"}>{value}</p>
    </div>
  )
}

function PreferredTools({
  tools,
  compact = false,
}: {
  tools: WorkflowNode["preferred_tools"]
  compact?: boolean
}) {
  const preferredTools = tools ?? []
  const visibleTools = compact ? preferredTools.slice(0, compactPreferredToolLimit) : preferredTools
  const overflowCount = compact ? Math.max(preferredTools.length - compactPreferredToolLimit, 0) : 0

  return (
    <div className={compact ? "contents" : "flex flex-col gap-2"}>
      {!compact ? (
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Preferred tools
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {preferredTools.length > 0 ? (
          <>
            {compact ? (
              <span
                className="text-muted-foreground inline-flex h-5 items-center"
                aria-label="Preferred tools"
              >
                <HammerIcon className="size-3.5" />
              </span>
            ) : null}
            {visibleTools.map((tool) => (
              <Badge key={tool} variant="secondary">
                {tool}
              </Badge>
            ))}
            {overflowCount > 0 ? <Badge variant="secondary">+{overflowCount} more</Badge> : null}
          </>
        ) : (
          <span className="text-muted-foreground text-sm">No preferred tools</span>
        )}
      </div>
    </div>
  )
}

function toCanvasNodes(workflow: WorkflowDefinition): WorkflowCanvasNode[] {
  return applyWorkflowLayout(
    workflow,
    workflow.nodes.map((node) => ({
      data: {
        handles: {
          source: false,
          target: false,
        },
        node,
      },
      id: node.name,
      position: {
        x: 0,
        y: 0,
      },
      type: "workflow",
    }))
  )
}

function toCanvasEdges(workflow: WorkflowDefinition): WorkflowCanvasEdge[] {
  return workflow.edges.map(
    (edge, index) =>
      ({
        data: {
          branchLabel: edge.branch_label,
          conditionSummary: edge.condition_summary,
        },
        id: `${edge.source}->${edge.target}:${index}`,
        label: edge.branch_label,
        source: edge.source,
        target: edge.target,
        type: "animated",
      }) satisfies WorkflowCanvasEdge
  )
}

function applyWorkflowLayout(
  workflow: WorkflowDefinition,
  nodes: WorkflowCanvasNode[]
): WorkflowCanvasNode[] {
  const graph = new dagre.graphlib.Graph<DagreGraphLabel, DagreNodeLabel>()
  const outgoingCounts = new Map<string, number>()
  const incomingTargets = new Set<string>()
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    align: "UL",
    nodesep: nodeSep,
    rankdir: "LR",
    ranksep: rankSep,
  })

  for (const node of workflow.nodes) {
    const existingNode = nodeById.get(node.name)
    const dimensions = getNodeDimensions(existingNode)
    outgoingCounts.set(node.name, 0)
    graph.setNode(node.name, {
      width: dimensions.width + nodeMarginX,
      height: dimensions.height + nodeMarginY,
    })
  }

  for (const edge of workflow.edges) {
    outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1)
    incomingTargets.add(edge.target)
    graph.setEdge(edge.source, edge.target)
  }

  dagre.layout(graph)

  return workflow.nodes.map((node) => {
    const layout = graph.node(node.name)
    if (!hasPosition(layout)) {
      throw new Error(`workflow node ${node.name} is missing dagre coordinates`)
    }

    const existingNode = nodeById.get(node.name)
    const { height, width } = getNodeDimensions(existingNode)

    return {
      ...existingNode,
      data: {
        handles: {
          source: (outgoingCounts.get(node.name) ?? 0) > 0,
          target: incomingTargets.has(node.name),
        },
        node,
      },
      id: node.name,
      position: {
        x: layout.x - width / 2,
        y: layout.y - height / 2,
      },
      type: "workflow",
    } satisfies WorkflowCanvasNode
  })
}

function getMeasuredLayoutSignature(nodes: WorkflowCanvasNode[]): string | null {
  if (nodes.length === 0) {
    return ""
  }

  const measuredDimensions: string[] = []
  for (const node of nodes) {
    const width = node.measured?.width
    const height = node.measured?.height
    if (typeof width !== "number" || typeof height !== "number") {
      return null
    }

    measuredDimensions.push(`${node.id}:${width}x${height}`)
  }

  return measuredDimensions.join("|")
}

function getNodeDimensions(node: WorkflowCanvasNode | undefined): {
  height: number
  width: number
} {
  return {
    height: node?.measured?.height ?? fallbackNodeHeight,
    width: node?.measured?.width ?? fallbackNodeWidth,
  }
}

function hasPosition(node: unknown): node is DagrePositionedNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "x" in node &&
    "y" in node &&
    "width" in node &&
    "height" in node &&
    typeof node.x === "number" &&
    typeof node.y === "number" &&
    typeof node.width === "number" &&
    typeof node.height === "number"
  )
}
