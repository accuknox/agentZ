"use client"

import dagre from "@dagrejs/dagre"
import { KeyRoundIcon, UsersIcon } from "lucide-react"
import type { NodeTypes, NodeProps as FlowNodeProps } from "@xyflow/react"
import { Handle, Position, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react"
import { AccessSourceChip, AdministrationState } from "@/components/administration"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  EffectiveAccessGraph,
  type EffectiveAccessNodeData,
} from "@/components/effective-access-graph"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TeamEffectiveAccessDetail } from "@/data/access"
import { cn } from "@/lib/utils"

type TeamNode = FlowNode<
  EffectiveAccessNodeData & {
    detail: string
    image?: string | null
    kind: "member" | "team" | "role" | "permission"
    label: string
  },
  "team-access"
>
type TeamEdge = FlowEdge<Record<string, never>, "static">

const nodeTypes = { "team-access": TeamAccessNode } satisfies NodeTypes
const nodeWidth = 220
const nodeHeight = 94

export function TeamAccessView({ detail }: { detail: TeamEffectiveAccessDetail }) {
  return (
    <EffectiveAccessGraph
      buildGraph={(sources, combinePermissions) =>
        teamAccessGraph(detail, sources, combinePermissions)
      }
      nodeTypes={nodeTypes}
      renderTable={(sources) => <TeamAccessTable detail={detail} sources={sources} />}
      sources={detail.sources}
      workspaces={detail.workspaces}
    />
  )
}

function teamAccessGraph(
  detail: TeamEffectiveAccessDetail,
  sources: TeamEffectiveAccessDetail["sources"],
  combinePermissions: boolean
) {
  const nodes = new Map<string, TeamNode>()
  const edges = new Map<string, TeamEdge>()
  const addNode = (id: string, data: Omit<TeamNode["data"], "muted" | "selected">) => {
    const node = nodes.get(id)
    if (node) {
      node.data.sourceIds = [...new Set([...node.data.sourceIds, ...data.sourceIds])]
    } else {
      nodes.set(id, {
        data: { ...data, muted: false, selected: false },
        id,
        position: { x: 0, y: 0 },
        type: "team-access",
      })
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
    sourceIds: sources.map((source) => source.id),
  })
  for (const member of detail.members) {
    const memberNode = addNode(`member:${member.id}`, {
      detail: member.email,
      image: member.image,
      kind: "member",
      label: member.name,
      sourceIds: sources.map((source) => source.id),
    })
    addEdge(memberNode, teamNode)
  }
  for (const source of sources) {
    const roleNode = addNode(`role:${source.role}:${source.workspaceId ?? "org"}`, {
      detail: source.scope,
      kind: "role",
      label: source.role,
      sourceIds: [source.id],
    })
    const permissionNode = addNode(
      combinePermissions
        ? `permission:${source.workspaceId ?? "org"}:${source.resource}:${source.action}`
        : `permission:${source.id}`,
      {
        detail: source.scope,
        kind: "permission",
        label: `${source.resource}.${source.action}`,
        sourceIds: [source.id],
      }
    )
    addEdge(teamNode, roleNode)
    addEdge(roleNode, permissionNode)
  }
  const flowEdges = [...edges.values()]
  const layout = new dagre.graphlib.Graph()
  layout.setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ marginx: 24, marginy: 24, nodesep: 42, rankdir: "LR", ranksep: 136 })
  for (const node of nodes.values()) {
    layout.setNode(node.id, { height: nodeHeight, width: nodeWidth })
  }
  for (const edge of flowEdges) layout.setEdge(edge.source, edge.target)
  dagre.layout(layout)
  return {
    edges: flowEdges,
    nodes: [...nodes.values()].map((node) => {
      const position = layout.node(node.id)
      return {
        ...node,
        position: { x: position.x - nodeWidth / 2, y: position.y - nodeHeight / 2 },
      }
    }),
  }
}

function TeamAccessNode({ data }: FlowNodeProps<TeamNode>) {
  const icon =
    data.kind === "member" ? (
      <Avatar size="sm">
        <AvatarImage alt="" src={data.image ?? undefined} />
        <AvatarFallback>{data.label.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
    ) : data.kind === "team" ? (
      <UsersIcon aria-hidden="true" className="size-4" />
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

function TeamAccessTable({
  detail,
  sources,
}: {
  detail: TeamEffectiveAccessDetail
  sources: TeamEffectiveAccessDetail["sources"]
}) {
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
    <div className="w-full min-w-0 border-b">
      <Table aria-label={`${detail.team.name} authoritative access paths`}>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Effective grant</TableHead>
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
    </div>
  )
}
