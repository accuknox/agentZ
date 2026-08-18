"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { BotIcon, Building2, Globe2, KeyRoundIcon, PanelsTopLeft, UsersIcon } from "lucide-react"
import type { Edge, EdgeTypes, Node, NodeProps, NodeTypes } from "@xyflow/react"
import { Handle, Position } from "@xyflow/react"
import { EffectiveAccessFrame } from "@/components/administration"
import { Canvas } from "@/components/ai-elements/canvas"
import { Controls } from "@/components/ai-elements/controls"
import { Edge as AccessEdge } from "@/components/ai-elements/edge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type EffectiveAccessNodeData = {
  detail: string
  image?: string | null
  kind: string
  label: string
  muted: boolean
  selected: boolean
  sourceIds: string[]
}

type AccessSource = { id: string; workspaceId: string | null }
type Workspace = { id: string; name: string }
type AccessNode = Node<EffectiveAccessNodeData>

const edgeTypes = { static: AccessEdge.Static } satisfies EdgeTypes
const nodeWidth = 220
const nodeHeight = 94

export function EffectiveAccessNode({ data }: NodeProps<Node<EffectiveAccessNodeData>>) {
  const icon =
    data.kind === "user" || data.kind === "member" ? (
      <Avatar size="sm">
        <AvatarImage alt="" src={data.image ?? undefined} />
        <AvatarFallback>{data.label.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
    ) : data.kind === "team" ? (
      <UsersIcon aria-hidden="true" className="size-4" />
    ) : data.kind === "agent" ? (
      <BotIcon aria-hidden="true" className="size-4" />
    ) : (
      <KeyRoundIcon aria-hidden="true" className="size-4" />
    )

  return (
    <div
      aria-label={`${data.kind}: ${data.label}`}
      className={cn(
        "bg-card text-card-foreground relative grid min-h-20 w-[220px] gap-1 rounded-xl border p-3 text-left shadow-sm transition-opacity motion-reduce:transition-none",
        data.kind === "permission" && "border-primary/30",
        data.selected && "ring-primary ring-2",
        data.muted && "opacity-25"
      )}
      role="group"
    >
      <Handle position={Position.Left} type="target" />
      <Handle position={Position.Right} type="source" />
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs font-medium tracking-normal">
        {icon}
        {data.kind}
      </div>
      <div className="truncate text-sm font-semibold" title={data.label}>
        {data.label}
      </div>
      <div className="text-muted-foreground truncate text-xs" title={data.detail}>
        {data.detail}
      </div>
    </div>
  )
}

export function layoutEffectiveAccessNodes<TNode extends AccessNode>(
  nodes: TNode[],
  edges: Edge[]
): TNode[] {
  const graph = new dagre.graphlib.Graph<DagreGraphLabel, DagreNodeLabel>()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ marginx: 24, marginy: 24, nodesep: 42, rankdir: "LR", ranksep: 136 })
  for (const node of nodes) {
    graph.setNode(node.id, {
      height: node.measured?.height ?? nodeHeight,
      width: node.measured?.width ?? nodeWidth,
    })
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target)
  }
  dagre.layout(graph)

  return nodes.map((node) => {
    const position = graph.node(node.id) as DagreNodeLabel & { x: number; y: number }
    return {
      ...node,
      position: {
        x: position.x - (node.measured?.width ?? nodeWidth) / 2,
        y: position.y - (node.measured?.height ?? nodeHeight) / 2,
      },
    }
  })
}

export function EffectiveAccessGraph<
  TSource extends AccessSource,
  TNode extends AccessNode,
  TEdge extends Edge,
>({
  buildGraph,
  nodeTypes,
  renderTable,
  sources,
  workspaces,
}: {
  buildGraph: (
    sources: TSource[],
    combinePermissions: boolean
  ) => {
    edges: TEdge[]
    nodes: TNode[]
  }
  nodeTypes: NodeTypes
  renderTable: (sources: TSource[]) => React.ReactNode
  sources: TSource[]
  workspaces: Workspace[]
}) {
  const [scope, setScope] = React.useState("all")
  const [selected, setSelected] = React.useState<string>()
  const visibleSources = React.useMemo(
    () =>
      sources.filter((source) => {
        if (scope === "all") return true
        if (scope === "org") return source.workspaceId === null
        return source.workspaceId === scope
      }),
    [scope, sources]
  )
  const graph = React.useMemo(
    () => buildGraph(visibleSources, scope === "all"),
    [buildGraph, scope, visibleSources]
  )
  const highlighted = React.useMemo(
    () => highlightedNodes(graph.nodes, graph.edges, selected),
    [graph, selected]
  )
  const nodes = graph.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      muted: Boolean(highlighted && !highlighted.has(node.id)),
      selected: node.id === selected,
    },
  }))
  const edges = graph.edges.map((edge) => ({
    ...edge,
    className: cn(
      highlighted &&
        (!highlighted.has(edge.source) || !highlighted.has(edge.target)) &&
        "opacity-15"
    ),
  }))
  const selectedNode = nodes.find((node) => node.id === selected)
  const tableSources = selectedNode
    ? visibleSources.filter((source) => selectedNode.data.sourceIds.includes(source.id))
    : visibleSources

  return (
    <EffectiveAccessFrame
      canvas={
        <div className="flex h-full min-h-[34rem] min-w-0 flex-col">
          <div className="bg-background/95 flex items-center gap-3 border-b p-3">
            <Select
              onValueChange={(value) => {
                setScope(value)
                setSelected(undefined)
              }}
              value={scope}
            >
              <SelectTrigger aria-label="Access scope" className="max-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <Globe2 /> All scopes
                </SelectItem>
                <SelectItem value="org">
                  <Building2 /> Organisation
                </SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    <PanelsTopLeft />
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="bg-sidebar relative min-h-0 flex-1 overflow-hidden">
            <Canvas
              className="bg-transparent"
              edges={edges}
              edgeTypes={edgeTypes}
              fitViewOptions={{ padding: 0.16 }}
              maxZoom={1.35}
              minZoom={0.25}
              nodes={nodes}
              nodesDraggable={false}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(undefined)}
            >
              <Controls position="bottom-left" showInteractive={false} />
            </Canvas>
          </div>
        </div>
      }
      table={renderTable(tableSources)}
    />
  )
}

function highlightedNodes(nodes: AccessNode[], edges: Edge[], selected?: string) {
  if (!selected || !nodes.some((node) => node.id === selected)) return

  const highlighted = new Set([selected])
  let changed = true
  while (changed) {
    changed = false
    for (const edge of edges) {
      if (highlighted.has(edge.target) && !highlighted.has(edge.source)) {
        highlighted.add(edge.source)
        changed = true
      }
    }
  }

  const descendants = new Set([selected])
  changed = true
  while (changed) {
    changed = false
    for (const edge of edges) {
      if (descendants.has(edge.source) && !descendants.has(edge.target)) {
        descendants.add(edge.target)
        changed = true
      }
    }
  }
  for (const id of descendants) highlighted.add(id)
  return highlighted
}
