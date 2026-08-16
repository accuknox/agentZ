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
import type { EffectiveAccessDetail, EffectiveAccessSource } from "@/data/access"

type AccessNodeData = EffectiveAccessNodeData & {
  kind: "user" | "source" | "role" | "team" | "agent" | "permission"
}

type AccessNode = FlowNode<AccessNodeData, "access">
type AccessEdge = FlowEdge<Record<string, never>, "static">

const nodeTypes = { access: EffectiveAccessNode } satisfies NodeTypes

export function AccessDetailView({ detail }: { detail: EffectiveAccessDetail }) {
  return (
    <EffectiveAccessGraph
      buildGraph={(sources, combinePermissions) => accessGraph(detail, sources, combinePermissions)}
      nodeTypes={nodeTypes}
      renderTable={(sources) => <AccessSourceTable sources={sources} />}
      sources={detail.sources}
      workspaces={detail.workspaces}
    />
  )
}

function accessGraph(
  detail: EffectiveAccessDetail,
  sources: EffectiveAccessSource[],
  combinePermissions: boolean
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
    image: detail.member.image,
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
        combinePermissions
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

  const flowEdges = [...edges.values()]
  return {
    edges: flowEdges,
    nodes: layoutEffectiveAccessNodes([...nodes.values()], flowEdges),
  }
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
    <div className="w-full min-w-0 border-b">
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
    </div>
  )
}
