"use client"

import * as React from "react"
import dagre from "@dagrejs/dagre"
import { KeyRoundIcon, ShieldCheckIcon, UsersIcon } from "lucide-react"
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
import type { TeamEffectiveAccessDetail } from "@/data/access"

type TeamNode = FlowNode<
  {
    detail: string
    kind: "member" | "team" | "role" | "permission"
    label: string
  },
  "team-access"
>
type TeamEdge = FlowEdge<Record<string, never>, "static">

const edgeTypes = { static: Edge.Static } satisfies EdgeTypes
const nodeTypes = { "team-access": TeamAccessNode } satisfies NodeTypes

export function TeamAccessView({ detail }: { detail: TeamEffectiveAccessDetail }) {
  const [scope, setScope] = React.useState("all")
  const sources = React.useMemo(
    () =>
      detail.sources.filter((source) => {
        if (scope === "all") return true
        if (scope === "org") return source.workspaceId === null
        return source.workspaceId === scope
      }),
    [detail.sources, scope]
  )
  const graph = React.useMemo(() => {
    const nodes = new Map<string, TeamNode>()
    const edges = new Map<string, TeamEdge>()
    const addNode = (id: string, data: TeamNode["data"]) => {
      if (!nodes.has(id)) {
        nodes.set(id, { data, id, position: { x: 0, y: 0 }, type: "team-access" })
      }
      return id
    }
    const addEdge = (source: string, target: string) => {
      const id = `${source}->${target}`
      if (!edges.has(id)) edges.set(id, { id, source, target, type: "static" })
    }
    const teamNode = addNode(`team:${detail.team.id}`, {
      detail: `${detail.members.length} members`,
      kind: "team",
      label: detail.team.name,
    })
    for (const member of detail.members) {
      const memberNode = addNode(`member:${member.id}`, {
        detail: member.email,
        kind: "member",
        label: member.name,
      })
      addEdge(memberNode, teamNode)
    }
    for (const source of sources) {
      const roleNode = addNode(`role:${source.role}:${source.workspaceId ?? "org"}`, {
        detail: source.scope,
        kind: "role",
        label: source.role,
      })
      const permissionNode = addNode(
        scope === "all"
          ? `permission:${source.workspaceId ?? "org"}:${source.resource}:${source.action}`
          : `permission:${source.id}`,
        { detail: source.scope, kind: "permission", label: `${source.resource}.${source.action}` }
      )
      addEdge(teamNode, roleNode)
      addEdge(roleNode, permissionNode)
    }
    const flowEdges = [...edges.values()]
    const layout = new dagre.graphlib.Graph()
    layout.setDefaultEdgeLabel(() => ({}))
    layout.setGraph({ marginx: 24, marginy: 24, nodesep: 36, rankdir: "LR", ranksep: 80 })
    for (const node of nodes.values()) layout.setNode(node.id, { height: 82, width: 210 })
    for (const edge of flowEdges) layout.setEdge(edge.source, edge.target)
    dagre.layout(layout)
    return {
      edges: flowEdges,
      nodes: [...nodes.values()].map((node) => {
        const position = layout.node(node.id)
        return { ...node, position: { x: position.x - 105, y: position.y - 41 } }
      }),
    }
  }, [detail, scope, sources])

  return (
    <EffectiveAccessFrame
      canvas={
        <div className="flex h-full min-h-[32rem] min-w-0 flex-col">
          <div className="bg-background flex items-center justify-between gap-3 border-b p-3">
            <Select onValueChange={setScope} value={scope}>
              <SelectTrigger aria-label="Team access scope" className="max-w-64">
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
            <span className="text-muted-foreground text-sm">{sources.length} paths</span>
          </div>
          <div className="bg-sidebar min-h-0 flex-1">
            <Canvas
              edges={graph.edges}
              edgeTypes={edgeTypes}
              fitViewOptions={{ padding: 0.18 }}
              maxZoom={1.35}
              minZoom={0.25}
              nodes={graph.nodes}
              nodesDraggable={false}
              nodeTypes={nodeTypes}
            >
              <Controls position="bottom-left" showInteractive={false} />
            </Canvas>
          </div>
        </div>
      }
      summary="Active Team members inherit the additive union of the Team's Role grants."
      table={<TeamAccessTable detail={detail} sources={sources} />}
    />
  )
}

function TeamAccessNode({ data }: FlowNodeProps<TeamNode>) {
  const icon =
    data.kind === "member" ? (
      <ShieldCheckIcon aria-hidden="true" className="size-4" />
    ) : data.kind === "team" ? (
      <UsersIcon aria-hidden="true" className="size-4" />
    ) : (
      <KeyRoundIcon aria-hidden="true" className="size-4" />
    )
  return (
    <div className="bg-card text-card-foreground relative grid min-h-20 w-[210px] gap-1 rounded-md border p-3 shadow-sm">
      <Handle position={Position.Left} type="target" />
      <Handle position={Position.Right} type="source" />
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase">
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

function TeamAccessTable({
  detail,
  sources,
}: {
  detail: TeamEffectiveAccessDetail
  sources: TeamEffectiveAccessDetail["sources"]
}) {
  if (sources.length === 0) {
    return <AdministrationState kind="empty" title="No Team Role grants in this scope" />
  }
  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label={`${detail.team.name} authoritative access paths`}>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Effective Grant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <TableRow key={source.id}>
                <TableCell>
                  <AccessSourceChip source="Team Role" />
                </TableCell>
                <TableCell>{source.scope}</TableCell>
                <TableCell>{`User -> ${detail.team.name} -> ${source.role}`}</TableCell>
                <TableCell className="font-medium">
                  {source.resource}.{source.action}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
