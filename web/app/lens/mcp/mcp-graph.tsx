"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { BotIcon, GaugeIcon, HammerIcon, HistoryIcon } from "lucide-react"
import {
  Handle,
  Position,
  type EdgeTypes,
  type NodeTypes,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps as FlowNodeProps,
} from "@xyflow/react"
import { Canvas } from "@/components/ai-elements/canvas"
import { Controls } from "@/components/ai-elements/controls"
import { Edge } from "@/components/ai-elements/edge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { mcpConnectionFallbackIcon, renderMcpServerIcon } from "@/app/mcps/catalog"
import { dayjs } from "@/lib/dayjs"
import type { McpGraphEdge, McpGraphResponse } from "@/lib/gateway/client"

type McpGraphProps = {
  graph: McpGraphResponse
}

type ToolMetrics = {
  lastCall?: string
  latencyMs?: number
}

type FlowHandles = {
  source: boolean
  target: boolean
}

type McpNodeData =
  | {
      kind: "agent" | "connection"
      label: string
      handles: FlowHandles
      serverURL?: string
    }
  | {
      kind: "tool"
      label: string
      handles: FlowHandles
      metrics: ToolMetrics
    }

type McpCanvasNode = FlowNode<McpNodeData, "mcp">
type McpCanvasEdge = FlowEdge<Record<string, never>, "animated">
type DagrePositionedNode = DagreNodeLabel & Required<Pick<DagreNodeLabel, "x" | "y">>

const fallbackNodeWidth = 184
const fallbackNodeHeight = 128
const fitViewPadding = 0.12
const nodeMarginX = 20
const nodeMarginY = 20
const nodeSep = 52
const rankSep = 120

const mcpEdgeTypes = {
  animated: Edge.Animated,
} satisfies EdgeTypes

const mcpNodeTypes = {
  mcp: McpNodeCircle,
} satisfies NodeTypes

/**
 * McpGraph renders the MCP path as agent, connection, and tool circles.
 */
export function McpGraph({ graph }: McpGraphProps) {
  const edgeCounts = React.useMemo(() => {
    return graph.edges.reduce(
      (counts, edge) => {
        const sourceID = flowSourceID(graph, edge)
        const targetID = flowTargetID(edge)
        counts.source.set(sourceID, (counts.source.get(sourceID) ?? 0) + 1)
        counts.target.set(targetID, (counts.target.get(targetID) ?? 0) + 1)
        return counts
      },
      {
        source: new Map<string, number>(),
        target: new Map<string, number>(),
      }
    )
  }, [graph])
  const toolMetricsByID = React.useMemo(() => {
    return graph.edges.reduce((metrics, edge) => {
      if (edge.kind !== "connection_tool") {
        return metrics
      }

      metrics.set(toolID(edge.target), {
        lastCall: edge.last_called_at ? dayjs(edge.last_called_at).fromNow() : undefined,
        latencyMs: edge.avg_latency_ms,
      })
      return metrics
    }, new Map<string, ToolMetrics>())
  }, [graph.edges])
  const edges = React.useMemo(() => {
    return graph.edges.map(
      (edge, index) =>
        ({
          id: `${edge.kind}:${edge.source}:${edge.target}:${index}`,
          source: flowSourceID(graph, edge),
          target: flowTargetID(edge),
          type: "animated",
        }) satisfies McpCanvasEdge
    )
  }, [graph])
  const initialNodes = React.useMemo(() => {
    return applyLayout(graph, [
      {
        data: {
          kind: "agent",
          label: graph.agent.name,
          handles: {
            source: (edgeCounts.source.get(agentID(graph.agent.name)) ?? 0) > 0,
            target: false,
          },
        },
        id: agentID(graph.agent.name),
        position: {
          x: 0,
          y: 0,
        },
        type: "mcp",
      },
      ...graph.connections.map(
        (connection) =>
          ({
            data: {
              kind: "connection",
              label: connection.name,
              handles: {
                source: (edgeCounts.source.get(connectionID(connection.id)) ?? 0) > 0,
                target: (edgeCounts.target.get(connectionID(connection.id)) ?? 0) > 0,
              },
              serverURL: connection.server_url,
            },
            id: connectionID(connection.id),
            position: {
              x: 0,
              y: 0,
            },
            type: "mcp",
          }) satisfies McpCanvasNode
      ),
      ...graph.tools.map(
        (tool) =>
          ({
            data: {
              kind: "tool",
              label: tool.name,
              handles: {
                source: false,
                target: (edgeCounts.target.get(toolID(tool.id)) ?? 0) > 0,
              },
              metrics: toolMetricsByID.get(toolID(tool.id)) ?? {},
            },
            id: toolID(tool.id),
            position: {
              x: 0,
              y: 0,
            },
            type: "mcp",
          }) satisfies McpCanvasNode
      ),
    ])
  }, [edgeCounts, graph, toolMetricsByID])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)

  return (
    <div className="bg-sidebar relative flex min-h-0 flex-1 overflow-hidden border-y">
      <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[10px_10px] opacity-35" />
      <Canvas
        className="bg-transparent"
        edges={edges}
        edgeTypes={mcpEdgeTypes}
        fitViewOptions={{ padding: fitViewPadding }}
        maxZoom={1.5}
        minZoom={0.35}
        nodes={nodes}
        nodesDraggable
        nodeTypes={mcpNodeTypes}
        onNodesChange={onNodesChange}
      >
        <McpAutoLayout graph={graph} setNodes={setNodes} />
        <Controls position="bottom-left" showInteractive={false} />
      </Canvas>
    </div>
  )
}

/**
 * McpEmptyState renders the empty MCP observability canvas.
 */
export function McpEmptyState({ agentName }: { agentName: string }) {
  return (
    <div className="flex flex-1 px-6 py-6">
      <div className="bg-sidebar text-muted-foreground relative flex min-h-105 w-full items-center justify-center overflow-hidden rounded-xl border text-sm">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[10px_10px] opacity-35" />
        <p className="relative">No MCP traffic for {agentName}</p>
      </div>
    </div>
  )
}

function McpAutoLayout({
  graph,
  setNodes,
}: {
  graph: McpGraphResponse
  setNodes: ReturnType<typeof useNodesState<McpCanvasNode>>[1]
}) {
  const nodesInitialized = useNodesInitialized()
  const reactFlow = useReactFlow<McpCanvasNode, McpCanvasEdge>()
  const lastLayoutRef = React.useRef<string | null>(null)
  const fitViewport = React.useEffectEvent(async () => {
    await reactFlow.fitView({
      duration: 200,
      maxZoom: 1,
      padding: fitViewPadding,
    })
  })

  React.useEffect(() => {
    lastLayoutRef.current = null
  }, [graph])

  React.useEffect(() => {
    if (!nodesInitialized) {
      return
    }

    const measuredNodes = reactFlow.getNodes()
    const signature = measuredNodes.reduce<string | null>((value, node) => {
      if (value === null) {
        return null
      }

      const width = node.measured?.width
      const height = node.measured?.height
      if (typeof width !== "number" || typeof height !== "number") {
        return null
      }

      return `${value}${value === "" ? "" : "|"}${node.id}:${width}x${height}`
    }, "")
    if (signature === null || lastLayoutRef.current === signature) {
      return
    }

    lastLayoutRef.current = signature
    setNodes(applyLayout(graph, measuredNodes))
    requestAnimationFrame(() => {
      void fitViewport()
    })
  }, [graph, nodesInitialized, reactFlow, setNodes])

  return null
}

function McpNodeCircle({ data }: FlowNodeProps<McpCanvasNode>) {
  const serverURL = data.kind === "connection" ? data.serverURL : undefined
  const icon =
    data.kind === "agent" ? (
      <BotIcon className="size-8" />
    ) : data.kind === "connection" ? (
      renderMcpServerIcon(serverURL ?? "", { className: "size-8" }, mcpConnectionFallbackIcon)
    ) : (
      <HammerIcon className="size-8" />
    )
  const tone =
    data.kind === "agent"
      ? "border-primary/30 bg-background text-primary"
      : "border-border bg-background text-foreground"
  const rootClassName =
    data.kind === "tool"
      ? "relative flex w-56 items-center justify-center"
      : "relative flex w-32 items-center justify-center"

  return (
    <div className={rootClassName}>
      {data.handles.target ? <Handle position={Position.Left} type="target" /> : null}
      {data.handles.source ? <Handle position={Position.Right} type="source" /> : null}
      <div className="relative flex w-full items-center">
        <div className="flex w-32 flex-col items-center gap-3 text-center">
          <div
            className={[
              "flex size-20 items-center justify-center rounded-full border shadow-sm",
              tone,
            ].join(" ")}
          >
            {icon}
          </div>
          <p className="text-foreground max-w-28 text-xs leading-tight font-medium wrap-break-word">
            {data.label}
          </p>
        </div>
        {data.kind === "tool" ? <ToolMetricsView metrics={data.metrics} /> : null}
      </div>
    </div>
  )
}

function ToolMetricsView({ metrics }: { metrics: ToolMetrics }) {
  if (!hasToolMetrics(metrics)) {
    return null
  }

  return (
    <div className="text-muted-foreground absolute top-1/2 left-31 flex -translate-y-1/2 flex-col gap-1 text-[11px] font-medium">
      {metrics.latencyMs !== undefined ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <GaugeIcon className="size-3" />
              {Math.round(metrics.latencyMs)} ms
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">Avg latency</TooltipContent>
        </Tooltip>
      ) : null}
      {metrics.lastCall ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <HistoryIcon className="size-3" />
              {metrics.lastCall}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Last called</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

function applyLayout(graph: McpGraphResponse, nodes: McpCanvasNode[]): McpCanvasNode[] {
  const dagreGraph = new dagre.graphlib.Graph<DagreGraphLabel, DagreNodeLabel>()
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))

  dagreGraph.setDefaultEdgeLabel(() => ({}))
  dagreGraph.setGraph({
    align: "UL",
    nodesep: nodeSep,
    rankdir: "LR",
    ranksep: rankSep,
  })

  for (const node of nodes) {
    const { height, width } = nodeSize(node)
    dagreGraph.setNode(node.id, {
      height: height + nodeMarginY,
      width: width + nodeMarginX,
    })
  }

  for (const edge of graph.edges) {
    dagreGraph.setEdge(flowSourceID(graph, edge), flowTargetID(edge))
  }

  dagre.layout(dagreGraph)

  return nodes.map((node) => {
    const layout = dagreGraph.node(node.id)
    if (!hasPosition(layout)) {
      throw new Error(`mcp graph node ${node.id} is missing dagre coordinates`)
    }

    const { height, width } = nodeSize(node)

    return {
      ...node,
      position: {
        x: layout.x - width / 2,
        y: layout.y - height / 2,
      },
    }
  })
}

function nodeSize(node: McpCanvasNode): { height: number; width: number } {
  return {
    height: node.measured?.height ?? fallbackNodeHeight,
    width: node.measured?.width ?? fallbackNodeWidth,
  }
}

function flowSourceID(graph: McpGraphResponse, edge: McpGraphEdge): string {
  if (edge.kind === "agent_connection") {
    return agentID(graph.agent.name)
  }

  return connectionID(edge.source)
}

function flowTargetID(edge: McpGraphEdge): string {
  if (edge.kind === "agent_connection") {
    return connectionID(edge.target)
  }

  return toolID(edge.target)
}

function agentID(name: string): string {
  return `agent:${name}`
}

function connectionID(id: string): string {
  return `connection:${id}`
}

function toolID(id: string): string {
  return `tool:${id}`
}

function hasToolMetrics(metrics: ToolMetrics): boolean {
  return metrics.latencyMs !== undefined || metrics.lastCall !== undefined
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
