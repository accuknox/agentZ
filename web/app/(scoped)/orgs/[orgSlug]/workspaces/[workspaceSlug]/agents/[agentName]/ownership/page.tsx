import { notFound } from "next/navigation"
import { AccessSourceChip } from "@/components/administration"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceScope } from "@/data/workspaces"
import { formatTimestamp } from "@/lib/format"
import { AgentOwnerForm } from "../agent-access-forms"

export default async function AgentOwnershipPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; agentName: string }>
}) {
  const { orgSlug, workspaceSlug, agentName } = await params
  const scope = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (scope.kind !== "ready") {
    notFound()
  }

  const detail = await getWorkspaceAgentDetail(
    scope.scope.organization.id,
    scope.workspace.id,
    agentName
  )
  if (!detail) {
    notFound()
  }

  const actionScope: AgentActionScope = {
    basePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}/agents`,
    workspaceId: scope.workspace.id,
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <AgentOwnerForm
        actionScope={actionScope}
        agentName={agentName}
        ownerUserId={detail.owner.owner_user_id}
        users={detail.ownerCandidates}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Ownership authority</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table aria-label={`${agentName} ownership authority`}>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Owner</TableCell>
                <TableCell className="break-words">{detail.ownerLabel}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Creator</TableCell>
                <TableCell className="break-words">{detail.creatorLabel}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Source</TableCell>
                <TableCell>
                  <AccessSourceChip source="Ownership" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Last transfer</TableCell>
                <TableCell>{formatTimestamp(detail.owner.updated_at)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
