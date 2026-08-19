import { notFound } from "next/navigation"
import { AccessSourceChip, AdministrationState } from "@/components/administration"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  RelativeDateTime,
  TableRow,
} from "@/components/ui/table"
import { UserIdentity } from "@/components/ui/avatar"
import { getWorkspaceAgentDetail } from "@/data/agent.queries"
import type { AgentActionScope } from "@/data/agent.actions"
import { getWorkspaceScope } from "@/data/workspaces"
import { AgentOwnerForm } from "../../agent-access-forms"

export const metadata = { title: "Ownership" }

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

  const detail = await getWorkspaceAgentDetail(scope.workspace.id, agentName)
  if (!detail) {
    notFound()
  }
  if (!detail.agent.capabilities.manage_ownership) {
    return <AdministrationState kind="forbidden" />
  }

  const actionScope: AgentActionScope = {
    workspaceId: scope.workspace.id,
    workspacePath: `/orgs/${scope.scope.organization.slug}/workspaces/${scope.workspace.slug}`,
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AgentOwnerForm
        actionScope={actionScope}
        agentName={agentName}
        ownerUserId={detail.owner.owner_user_id}
        users={detail.ownerCandidates}
      />
      <section className="min-w-0 space-y-3">
        <h2 className="px-4 text-lg font-medium md:px-6">Ownership</h2>
        <div className="w-full min-w-0 border-b">
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
                <TableCell>
                  <UserIdentity
                    email={detail.ownerTarget?.email}
                    image={detail.ownerTarget?.image}
                    name={detail.ownerLabel}
                  />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Creator</TableCell>
                <TableCell>
                  <UserIdentity
                    email={detail.creatorTarget?.email}
                    image={detail.creatorTarget?.image}
                    name={detail.creatorLabel}
                  />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Source</TableCell>
                <TableCell>
                  <AccessSourceChip source="Ownership" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Last transfer</TableCell>
                <TableCell>
                  <RelativeDateTime value={detail.owner.updated_at} />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
