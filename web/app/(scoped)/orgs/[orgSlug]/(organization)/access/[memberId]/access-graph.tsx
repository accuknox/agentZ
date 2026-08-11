"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import type { GraphLabel as DagreGraphLabel, NodeLabel as DagreNodeLabel } from "@dagrejs/dagre"
import { BotIcon, KeyRoundIcon, RotateCcwIcon, ShieldCheckIcon, UsersIcon } from "lucide-react"
import type { EdgeTypes, NodeTypes, NodeProps as FlowNodeProps } from "@xyflow/react"
import { Handle, Position, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react"
import {
  AccessSourceChip,
  AdministrationState,
  EffectiveAccessFrame,
} from "@/components/administration"
import { Canvas } from "@/components/ai-elements/canvas"
import { Controls } from "@/components/ai-elements/controls"
import { Edge } from "@/components/ai-elements/edge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { EffectiveAccessDetail, EffectiveAccessSource } from "@/data/access"
import { cn } from "@/lib/utils"

type AccessNodeData = {
  detail: string
  kind: "user" | "source" | "role" | "team" | "agent" | "permission"
  label: string
  muted: boolean
  selected: boolean
  sourceIds: string[]
}

type AccessNode = FlowNode<AccessNodeData, "access">
type AccessEdge = FlowEdge<Record<string, never>, "static">

const edgeTypes = { static: Edge.Static } satisfies EdgeTypes
const nodeTypes = { access: AccessGraphNode } satisfies NodeTypes
const nodeWidth = 220
const nodeHeight = 94

export function AccessDetailView({ detail }: { detail: EffectiveAccessDetail }) {
  const [scope, setScope] = React.useState("all")
  const [expanded, setExpanded] = React.useState(false)
  const [selected, setSelected] = React.useState<string>()
  const visibleSources = React.useMemo(
    () =>
      detail.sources.filter((source) => {
        if (scope === "all") return true
        if (scope === "org") return source.workspaceId === null
        return source.workspaceId === scope
      }),
    [detail.sources, scope]
  )
  const graph = React.useMemo(
    () => accessGraph(detail, visibleSources, scope === "all" && !expanded),
    [detail, expanded, scope, visibleSources]
  )
  const highlighted = React.useMemo(() => {
    if (!selected || !graph.nodes.some((node) => node.id === selected)) return
    const ids = new Set([selected])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of graph.edges) {
        if (ids.has(edge.target) && !ids.has(edge.source)) {
          ids.add(edge.source)
          changed = true
        }
      }
    }
    const descendants = new Set([selected])
    changed = true
    while (changed) {
      changed = false
      for (const edge of graph.edges) {
        if (descendants.has(edge.source) && !descendants.has(edge.target)) {
          descendants.add(edge.target)
          changed = true
        }
      }
    }
    for (const id of descendants) ids.add(id)
    return ids
  }, [graph, selected])
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
          <div className="bg-background/95 flex flex-wrap items-center justify-between gap-2 border-b p-3">
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
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="org">Organisation</SelectItem>
                {detail.workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{visibleSources.length} paths</span>
              <Button
                onClick={() => setExpanded((value) => !value)}
                size="sm"
                type="button"
                variant="outline"
              >
                <KeyRoundIcon aria-hidden="true" />
                {expanded ? "Collapse permissions" : "Expand permissions"}
              </Button>
              <Button
                aria-label="Reset graph selection"
                disabled={!selected}
                onClick={() => setSelected(undefined)}
                size="icon-sm"
                title="Reset graph selection"
                type="button"
                variant="outline"
              >
                <RotateCcwIcon aria-hidden="true" />
              </Button>
            </div>
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
      inspector={
        <div className="grid gap-4 text-sm">
          <div>
            <div className="font-medium">{selectedNode?.data.label ?? detail.member.name}</div>
            <div className="text-muted-foreground truncate">
              {selectedNode?.data.detail ?? detail.member.email}
            </div>
          </div>
          <Badge
            variant={
              detail.member.status === "active"
                ? "successPlain"
                : detail.member.status === "disabled"
                  ? "destructivePlain"
                  : "warningPlain"
            }
          >
            {detail.member.status}
          </Badge>
          <div className="grid gap-2">
            {[...new Set(tableSources.map((source) => source.source))].map((source) => (
              <AccessSourceChip key={source} source={source} />
            ))}
          </div>
          <div className="text-muted-foreground">
            {selectedNode
              ? `${tableSources.length} contributing paths`
              : `${visibleSources.length} effective paths`}
          </div>
        </div>
      }
      summary="Effective grants reconstructed from direct Roles, Team Roles, administrative assignments, ownership, and Agent Shares."
      table={<AccessSourceTable sources={tableSources} />}
    />
  )
}

function accessGraph(
  detail: EffectiveAccessDetail,
  sources: EffectiveAccessSource[],
  collapsed: boolean
) {
  const userNode = `user:${detail.member.id}`
  const nodes = new Map<string, AccessNode>()
  const edges = new Map<string, AccessEdge>()
  const addNode = (id: string, data: Omit<AccessNodeData, "muted" | "selected">) => {
    const node = nodes.get(id)
    if (node) {
      node.data.sourceIds = [...new Set([...node.data.sourceIds, ...data.sourceIds])]
      return id
    }
    nodes.set(id, {
      data: { ...data, muted: false, selected: false },
      id,
      position: { x: 0, y: 0 },
      type: "access",
    })
    return id
  }
  const addEdge = (source: string, target: string, label?: string) => {
    const id = `${source}->${target}`
    if (!edges.has(id)) edges.set(id, { id, label, source, target, type: "static" })
  }

  addNode(userNode, {
    detail: detail.member.email,
    kind: "user",
    label: detail.member.name,
    sourceIds: sources.map((source) => source.id),
  })
  for (const source of sources) {
    if (source.source === "Superadmin" || source.source === "Workspace Admin") {
      const roleNode = addNode(`admin:${source.source}:${source.workspaceId ?? "org"}`, {
        detail: source.scope,
        kind: "role",
        label: source.role,
        sourceIds: [source.id],
      })
      const permissionNode = addNode(
        collapsed
          ? `permission:${source.workspaceId ?? "org"}:administration:administer`
          : `permission:${source.id}`,
        {
          detail: source.scope,
          kind: "permission",
          label: "administration.administer",
          sourceIds: [source.id],
        }
      )
      addEdge(userNode, roleNode, source.source)
      addEdge(roleNode, permissionNode)
      continue
    }
    if (source.source === "Direct Role" || source.source === "Team Role") {
      const parentNode =
        source.source === "Team Role"
          ? addNode(`team:${source.team}`, {
              detail: source.scope,
              kind: "team",
              label: source.team,
              sourceIds: [source.id],
            })
          : addNode(`source:direct:${source.role}:${source.workspaceId ?? "org"}`, {
              detail: source.scope,
              kind: "source",
              label: "Direct Role",
              sourceIds: [source.id],
            })
      const roleNode = addNode(`${source.source}:${source.role}:${source.workspaceId ?? "org"}`, {
        detail: source.scope,
        kind: "role",
        label: source.role,
        sourceIds: [source.id],
      })
      const permissionNode = addNode(
        collapsed
          ? `permission:${source.workspaceId ?? "org"}:${source.resource}:${source.action}`
          : `permission:${source.id}`,
        {
          detail: source.scope,
          kind: "permission",
          label: `${source.resource}.${source.action}`,
          sourceIds: [source.id],
        }
      )
      addEdge(userNode, parentNode)
      addEdge(parentNode, roleNode, source.source)
      addEdge(roleNode, permissionNode)
      continue
    }
    if (source.source === "Ownership") {
      const ownerNode = addNode(`source:owner:${source.workspaceId}`, {
        detail: source.scope,
        kind: "source",
        label: "Ownership",
        sourceIds: [source.id],
      })
      const agentNode = addNode(`agent:${source.workspaceId}:${source.agent}`, {
        detail: source.scope,
        kind: "agent",
        label: source.agent,
        sourceIds: [source.id],
      })
      addEdge(userNode, ownerNode)
      addEdge(ownerNode, agentNode)
      continue
    }
    const shareNode =
      source.source === "Team Share"
        ? addNode(`team-share:${source.team}:${source.workspaceId}`, {
            detail: source.scope,
            kind: "team",
            label: source.team,
            sourceIds: [source.id],
          })
        : addNode(`source:direct-share:${source.workspaceId}`, {
            detail: source.scope,
            kind: "source",
            label: "Direct Share",
            sourceIds: [source.id],
          })
    const agentNode = addNode(`agent:${source.workspaceId}:${source.agent}`, {
      detail: source.scope,
      kind: "agent",
      label: source.agent,
      sourceIds: [source.id],
    })
    const permissionNode = addNode(`capability:${source.id}`, {
      detail: source.scope,
      kind: "permission",
      label: source.capability,
      sourceIds: [source.id],
    })
    addEdge(userNode, shareNode, source.source)
    addEdge(shareNode, agentNode)
    addEdge(agentNode, permissionNode)
  }

  return { edges: [...edges.values()], nodes: layout([...nodes.values()], [...edges.values()]) }
}

function layout(nodes: AccessNode[], edges: AccessEdge[]) {
  const graph = new dagre.graphlib.Graph<DagreGraphLabel, DagreNodeLabel>()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ marginx: 24, marginy: 24, nodesep: 42, rankdir: "LR", ranksep: 86 })
  for (const node of nodes) {
    graph.setNode(node.id, {
      height: node.measured?.height ?? nodeHeight,
      width: node.measured?.width ?? nodeWidth,
    })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
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

function AccessGraphNode({ data }: FlowNodeProps<AccessNode>) {
  const icon =
    data.kind === "user" ? (
      <ShieldCheckIcon aria-hidden="true" className="size-4" />
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
        "bg-card text-card-foreground relative grid min-h-20 w-[220px] gap-1 rounded-md border p-3 text-left shadow-sm transition-opacity motion-reduce:transition-none",
        data.kind === "permission" && "border-primary/30",
        data.selected && "ring-primary ring-2",
        data.muted && "opacity-25"
      )}
      role="group"
    >
      <Handle position={Position.Left} type="target" />
      <Handle position={Position.Right} type="source" />
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs font-medium tracking-normal uppercase">
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

function AccessSourceTable({ sources }: { sources: EffectiveAccessSource[] }) {
  if (sources.length === 0) {
    return (
      <AdministrationState
        description="No effective grants exist in this scope or selected path."
        kind="empty"
        title="No effective access"
      />
    )
  }
  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label="Authoritative effective access source paths">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Effective grant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => {
              let path: string
              let grant: string
              if (source.source === "Superadmin" || source.source === "Workspace Admin") {
                path = `User -> ${source.role}`
                grant = `${source.resource}.${source.action}`
              } else if (source.source === "Direct Role") {
                path = `User -> ${source.role}`
                grant = `${source.resource}.${source.action}`
              } else if (source.source === "Team Role") {
                path = `User -> ${source.team} -> ${source.role}`
                grant = `${source.resource}.${source.action}`
              } else if (source.source === "Ownership") {
                path = `User -> Owner -> ${source.agent}`
                grant = "Agent ownership"
              } else if (source.source === "Team Share") {
                path = `User -> ${source.team} -> ${source.agent}`
                grant = source.capability
              } else {
                path = `User -> Direct Share -> ${source.agent}`
                grant = source.capability
              }
              return (
                <TableRow key={source.id}>
                  <TableCell>
                    <AccessSourceChip source={source.source} />
                  </TableCell>
                  <TableCell className="max-w-56 truncate" title={source.scope}>
                    {source.scope}
                  </TableCell>
                  <TableCell className="max-w-md text-sm">{path}</TableCell>
                  <TableCell className="max-w-md text-sm font-medium">{grant}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
