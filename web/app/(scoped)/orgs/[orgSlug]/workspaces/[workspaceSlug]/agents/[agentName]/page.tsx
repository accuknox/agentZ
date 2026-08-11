import { notFound } from "next/navigation"
import { Badge } from "@/components/ui/badge"
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
import { getWorkspaceScope } from "@/data/workspaces"
import { formatTimestamp } from "@/lib/format"

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

  const detail = await getWorkspaceAgentDetail(
    scope.scope.organization.id,
    scope.workspace.id,
    agentName
  )
  if (!detail) {
    notFound()
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Runtime configuration</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table aria-label={`${detail.agent.name} configuration`}>
            <TableBody>
              <SummaryRow label="Sandbox">
                <Badge variant="outline">{detail.agent.sandbox.scope}</Badge>
                <span>{detail.agent.sandbox.name}</span>
              </SummaryRow>
              <SummaryRow label="Memory">
                {detail.agent.memory.enabled ? "Enabled" : "Disabled"}
              </SummaryRow>
              <SummaryRow label="Created">{formatTimestamp(detail.agent.created_at)}</SummaryRow>
              <SummaryRow label="Modified">{formatTimestamp(detail.agent.modified_at)}</SummaryRow>
              <SummaryRow label="Last activity">
                {formatTimestamp(detail.agent.last_activity)}
              </SummaryRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Access summary</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                <TableCell className="break-words">{detail.ownerLabel}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Creator</TableCell>
                <TableCell className="break-words">{detail.creatorLabel}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Shares</TableCell>
                <TableCell>{detail.shares.length}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryRow({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <TableRow>
      <TableCell className="text-muted-foreground w-40">{label}</TableCell>
      <TableCell className="flex flex-wrap items-center gap-2 break-words">{children}</TableCell>
    </TableRow>
  )
}
