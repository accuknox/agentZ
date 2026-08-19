import { notFound } from "next/navigation"
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
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata = { title: "Summary" }

export default async function WorkspaceAgentPage({
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

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="min-w-0 space-y-3">
        <h2 className="px-4 text-lg font-medium md:px-6">Runtime configuration</h2>
        <div className="w-full min-w-0 border-b">
          <Table aria-label={`${detail.agent.name} configuration`}>
            <TableBody>
              <SummaryRow label="Sandbox">
                <span className="text-muted-foreground">{detail.agent.sandbox.scope}</span>
                <span>{detail.agent.sandbox.name}</span>
              </SummaryRow>
              <SummaryRow label="Memory">
                {detail.agent.memory.enabled ? "Enabled" : "Disabled"}
              </SummaryRow>
              <SummaryRow label="Created">
                <RelativeDateTime value={detail.agent.created_at} />
              </SummaryRow>
              <SummaryRow label="Modified">
                <RelativeDateTime value={detail.agent.modified_at} />
              </SummaryRow>
              <SummaryRow label="Last activity">
                <RelativeDateTime value={detail.agent.last_activity} />
              </SummaryRow>
            </TableBody>
          </Table>
        </div>
      </section>
      {detail.agent.capabilities.share || detail.agent.capabilities.manage_ownership ? (
        <section className="min-w-0 space-y-3">
          <h2 className="px-4 text-lg font-medium md:px-6">Access</h2>
          <div className="w-full min-w-0 border-b">
            <Table aria-label={`${detail.agent.name} access summary`}>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Principal</TableHead>
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
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

function SummaryRow({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground w-40">{label}</TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-2 break-words">{children}</span>
      </TableCell>
    </TableRow>
  )
}
