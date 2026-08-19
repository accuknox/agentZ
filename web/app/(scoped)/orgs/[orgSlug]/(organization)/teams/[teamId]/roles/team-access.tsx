"use client"

import type { NodeTypes, Edge as FlowEdge, Node as FlowNode } from "@xyflow/react"
import { AccessSourceChip, AdministrationState } from "@/components/administration"
import {
  EffectiveAccessGraph,
  EffectiveAccessNode,
  type EffectiveAccessNodeData,
  layoutEffectiveAccessNodes,
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

type TeamNode = FlowNode<
  EffectiveAccessNodeData & {
    kind: "member" | "team" | "role" | "permission"
  },
  "team-access"
>
type TeamEdge = FlowEdge<Record<string, never>, "static">

const nodeTypes = { "team-access": EffectiveAccessNode } satisfies NodeTypes

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
  return {
    edges: flowEdges,
    nodes: layoutEffectiveAccessNodes([...nodes.values()], flowEdges),
  }
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
              <TableCell>{`User → ${detail.team.name} → ${source.role}`}</TableCell>
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
