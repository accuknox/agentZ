"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { CornerDownLeftIcon, HammerIcon, SparklesIcon, XIcon } from "lucide-react"
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
import { Node, NodeContent } from "@/components/ai-elements/node"
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

type DagrePositionedNode = DagreNodeLabel & { x: number; y: number }

const fallbackNodeWidth = 304
const fallbackNodeHeight = 92
const nodeMarginX = 28
const nodeMarginY = 28
const rankSep = 136
const nodeSep = 88
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
    <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-t">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--color-primary)_0%,transparent_32%)] opacity-10" />
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[14px_14px] opacity-35" />
        <div className="from-background/22 absolute inset-x-0 top-0 h-32 bg-linear-to-b to-transparent" />
      </div>
      <Canvas
        className="bg-transparent"
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
        <Panel
          position="top-left"
          className="bg-card/88 supports-[backdrop-filter]:bg-card/72 border-border/70 w-sm max-w-sm overflow-hidden border p-0 shadow-lg shadow-black/5 backdrop-blur-md"
        >
          <Collapsible defaultOpen={false} className="group/workflow-summary">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted/35 focus-visible:ring-ring/60 flex w-full items-start gap-2 px-3 py-2.5 text-left outline-hidden transition-colors focus-visible:ring-2"
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
            className="bg-card/90 supports-[backdrop-filter]:bg-card/76 animate-in fade-in slide-in-from-right-2 border-border/70 max-h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border p-4 shadow-xl shadow-black/10 backdrop-blur-md duration-200"
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
              <PreferenceList
                emptyLabel="No preferred skills"
                icon={<SparklesIcon className="size-3.5" />}
                items={selectedWorkflowNode.preferred_skills}
                title="Preferred skills"
              />
              <PreferenceList
                emptyLabel="No preferred tools"
                icon={<HammerIcon className="size-3.5" />}
                items={selectedWorkflowNode.preferred_tools}
                title="Preferred tools"
              />
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
  const skillCount = data.node.preferred_skills?.length ?? 0
  const toolCount = data.node.preferred_tools?.length ?? 0

  return (
    <Node
      handles={data.handles}
      className={
        selected
          ? "bg-background/96 border-primary/65 shadow-primary/15 dark:bg-accent/90 w-[19rem] rounded-xl border-2 shadow-[0_18px_48px_-28px_var(--color-primary)] transition-all duration-200 ease-out"
          : "bg-background/94 hover:border-primary/35 border-border/80 dark:bg-accent/82 w-[19rem] rounded-xl shadow-[0_16px_40px_-30px_rgb(15_23_42/0.45)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_20px_44px_-28px_var(--color-primary)]"
      }
    >
      <NodeContent className="flex items-center justify-between gap-5 px-4 py-3.5">
        <p className="truncate text-sm font-semibold tracking-[0.01em]">{data.node.name}</p>
        <div className="text-muted-foreground flex shrink-0 items-center gap-4 text-sm font-medium">
          <span
            className="inline-flex items-center gap-1.5"
            aria-label={`Preferred skills: ${skillCount}`}
          >
            <SparklesIcon className="text-chart-1 size-4" />
            <span className="text-foreground/90 font-mono">x{skillCount}</span>
          </span>
          <span
            className="inline-flex items-center gap-1.5"
            aria-label={`Preferred tools: ${toolCount}`}
          >
            <HammerIcon className="text-chart-2 size-4" />
            <span className="text-foreground/90 font-mono">x{toolCount}</span>
          </span>
        </div>
      </NodeContent>
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

function PreferenceList({
  items,
  emptyLabel,
  icon,
  title,
}: {
  items?: Array<string>
  emptyLabel: string
  icon: React.ReactNode
  title: string
}) {
  const totalItems = items?.length ?? 0

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
      <div className="flex flex-wrap gap-2">
        {totalItems > 0 ? (
          <>
            <span className="text-muted-foreground inline-flex h-5 items-center" aria-hidden="true">
              {icon}
            </span>
            {(items ?? []).map((item) => (
              <Badge key={item} variant="secondary">
                {item}
              </Badge>
            ))}
          </>
        ) : (
          <span className="text-muted-foreground text-sm">{emptyLabel}</span>
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
  const graph = new dagre.graphlib.Graph<DagreGraphLabel, DagrePositionedNode>()
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
      x: 0,
      y: 0,
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
