"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { GaugeIcon, HammerIcon, HistoryIcon } from "lucide-react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { mcpConnectionFallbackIcon, renderMcpServerIcon } from "@/app/(app)/mcps/catalog"
import { formatAge } from "@/lib/format"
import type { McpGraphResponse } from "@/lib/gateway/client"

import { LensSourceIcon } from "../lens-filters"
import type { LensSubject } from "@/data/types"

type McpGraphData = Pick<McpGraphResponse, "connections" | "tools" | "edges">

type McpGraphProps = {
  subject: LensSubject
  graph: McpGraphData
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
  | { kind: "subject"; subject: LensSubject; label: string; handles: FlowHandles }
  | { kind: "connection"; label: string; handles: FlowHandles; serverURL?: string }
  | { kind: "tool"; label: string; handles: FlowHandles; metrics: ToolMetrics }

type McpCanvasNode = FlowNode<McpNodeData, "mcp">
type McpCanvasEdge = FlowEdge<Record<string, never>, "animated">
type DagrePositionedNode = DagreNodeLabel & { x: number; y: number }

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
 * McpGraph renders a subject, its selected connections and executed tools.
 */
export function McpGraph({ graph, subject }: McpGraphProps) {
  const rootID = subject.kind !== "agent" ? `app:${subject.clientID}` : `agent:${subject.name}`
  const { edges, sources, targets, toolMetrics } = React.useMemo(() => {
    const sources = new Set<string>()
    const targets = new Set<string>()
    const toolMetrics = new Map<string, ToolMetrics>()
    const edges = graph.edges.map((edge, index): McpCanvasEdge => {
      const source = edge.kind === "connection_tool" ? `connection:${edge.source}` : edge.source
      const target = `${edge.kind === "connection_tool" ? "tool" : "connection"}:${edge.target}`
      sources.add(source)
      targets.add(target)
      if (edge.kind === "connection_tool") {
        toolMetrics.set(target, {
          lastCall: edge.last_called_at ? formatAge(edge.last_called_at) : undefined,
          latencyMs: edge.avg_latency_ms,
        })
      }
      return {
        id: `${edge.kind}:${edge.source}:${edge.target}:${index}`,
        source,
        target,
        type: "animated",
      }
    })
    return { edges, sources, targets, toolMetrics }
  }, [graph.edges])
  const initialNodes = React.useMemo(() => {
    return applyLayout(edges, [
      {
        data: {
          kind: "subject",
          subject,
          label: subject.name,
          handles: {
            source: sources.has(rootID),
            target: false,
          },
        },
        id: rootID,
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
                source: sources.has(`connection:${connection.id}`),
                target: targets.has(`connection:${connection.id}`),
              },
              serverURL: connection.server_url,
            },
            id: `connection:${connection.id}`,
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
                target: targets.has(`tool:${tool.id}`),
              },
              metrics: toolMetrics.get(`tool:${tool.id}`) ?? {},
            },
            id: `tool:${tool.id}`,
            position: {
              x: 0,
              y: 0,
            },
            type: "mcp",
          }) satisfies McpCanvasNode
      ),
    ])
  }, [edges, graph.connections, graph.tools, rootID, sources, subject, targets, toolMetrics])
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden border-y bg-sidebar">
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
        <McpAutoLayout edges={edges} setNodes={setNodes} />
        <Controls position="bottom-left" showInteractive={false} />
      </Canvas>
    </div>
  )
}

/**
 * McpGraphSkeleton preserves the graph canvas while its topology loads.
 */
export function McpGraphSkeleton() {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden border-y bg-sidebar">
      <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[10px_10px] opacity-35" />
      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-8">
        <div className="flex min-w-max items-center gap-8 sm:gap-14 lg:gap-24">
          <div className="flex w-32 flex-col items-center gap-3">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-px w-16 rounded-none sm:w-24" />
          <div className="flex w-32 flex-col items-center gap-3">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-px w-16 rounded-none sm:w-24" />
          <div className="flex w-32 flex-col items-center gap-3">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </div>
      <div className="absolute bottom-4 left-4 flex overflow-hidden rounded-md border shadow-xs">
        <Skeleton className="size-8 rounded-none" />
        <Skeleton className="size-8 rounded-none border-x" />
        <Skeleton className="size-8 rounded-none" />
      </div>
    </div>
  )
}

/**
 * McpEmptyState renders the empty MCP observability canvas.
 */
export function McpEmptyState({ subjectName }: { subjectName: string }) {
  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden border-y bg-sidebar text-sm text-muted-foreground">
      <div className="absolute inset-0 bg-[radial-gradient(circle,var(--color-sidebar-border)_1px,transparent_1px)] bg-size-[10px_10px] opacity-35" />
      <p className="relative">No MCP traffic for {subjectName}</p>
    </div>
  )
}

function McpAutoLayout({
  edges,
  setNodes,
}: {
  edges: McpCanvasEdge[]
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
  }, [edges])

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
      if (width === undefined || height === undefined) {
        return null
      }

      return `${value}${value === "" ? "" : "|"}${node.id}:${width}x${height}`
    }, "")
    if (signature === null || lastLayoutRef.current === signature) {
      return
    }

    lastLayoutRef.current = signature
    setNodes(applyLayout(edges, measuredNodes))
    requestAnimationFrame(() => {
      void fitViewport()
    })
  }, [edges, nodesInitialized, reactFlow, setNodes])

  return null
}

function McpNodeCircle({ data }: FlowNodeProps<McpCanvasNode>) {
  let icon: React.ReactNode
  switch (data.kind) {
    case "subject":
      icon = (
        <LensSourceIcon
          kind={
            data.subject.kind === "external-agent" ? data.subject.providerKind : data.subject.kind
          }
          className="size-8"
        />
      )
      break
    case "connection":
      icon = renderMcpServerIcon(
        data.serverURL ?? "",
        { className: "size-8" },
        mcpConnectionFallbackIcon
      )
      break
    case "tool":
      icon = <HammerIcon className="size-8" />
      break
  }
  const tone =
    data.kind === "subject"
      ? "border-primary/30 bg-background text-primary dark:bg-accent"
      : "border-border bg-background text-foreground dark:bg-accent"
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
          <p className="max-w-28 text-xs leading-tight font-medium wrap-break-word text-foreground">
            {data.label}
          </p>
        </div>
        {data.kind === "tool" ? <ToolMetricsView metrics={data.metrics} /> : null}
      </div>
    </div>
  )
}

function ToolMetricsView({ metrics }: { metrics: ToolMetrics }) {
  if (metrics.latencyMs === undefined && metrics.lastCall === undefined) {
    return null
  }

  return (
    <div className="absolute top-1/2 left-31 flex -translate-y-1/2 flex-col gap-1 text-[11px] font-medium text-muted-foreground">
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

function applyLayout(edges: McpCanvasEdge[], nodes: McpCanvasNode[]): McpCanvasNode[] {
  const dagreGraph = new dagre.graphlib.Graph<DagreGraphLabel, DagrePositionedNode>()

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
      x: 0,
      y: 0,
    })
  }

  for (const edge of edges) {
    dagreGraph.setEdge(edge.source, edge.target)
  }

  dagre.layout(dagreGraph)

  return nodes.map((node) => {
    const layout = dagreGraph.node(node.id)
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
