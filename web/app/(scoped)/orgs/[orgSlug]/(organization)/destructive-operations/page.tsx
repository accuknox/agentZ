import { RefreshCwIcon } from "lucide-react"
import { retryDestructiveOperationAction } from "@/app/(scoped)/orgs/actions"
import {
  AdministrationPageHeader,
  AdministrationState,
  ImpactReviewFrame,
} from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listDestructiveOperations } from "@/data/operations"
import { formatTimestampWithAge } from "@/lib/format"

export default async function DestructiveOperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ job?: string }>
}) {
  const { orgSlug } = await params
  const { job } = await searchParams
  const data = await listDestructiveOperations(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Operations" />
      <ImpactReviewFrame
        description="Destructive workflows revoke access before external cleanup and keep retry state visible. Workspace deletion, membership disable/remove, Team deletion, and Role reduction all flow through this queue."
        items={[
          {
            id: "revoke",
            label: "Authorization is revoked transactionally before cleanup starts.",
            group: "Authorization",
            severity: "critical",
          },
          {
            id: "retry",
            label: "Kubernetes, OpenBao, and S3 cleanup retries are tracked durably.",
            group: "External cleanup",
            severity: "warning",
          },
          {
            id: "audit",
            label: "Audit Events retain safe summaries for the rolling 30-day window.",
            group: "Audit",
            severity: "info",
          },
        ]}
        title="Destructive Impact Workflow"
      />
      {data.rows.length === 0 ? (
        <AdministrationState
          description="No destructive cleanup jobs are pending, retrying, failed, or completed."
          kind="empty"
          title="No destructive operations"
        />
      ) : (
        <div className="border-y">
          <Table aria-label="Destructive Operations">
            <TableHeader>
              <TableRow>
                <TableHead>Operation</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Next Transition</TableHead>
                <TableHead>Last Error</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow className={row.id === job ? "bg-muted/50" : undefined} key={row.id}>
                  <TableCell className="font-medium">{row.operation}</TableCell>
                  <TableCell className="max-w-72">
                    <div className="truncate">{row.targetType}</div>
                    <div className="text-muted-foreground truncate text-xs" title={row.targetId}>
                      {row.targetId}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-72">
                    {row.impact.length ? (
                      <span className="text-sm">{row.impact.join(", ")}</span>
                    ) : (
                      <span className="text-muted-foreground">None recorded</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.state === "succeeded"
                          ? "successPlain"
                          : row.state === "failed"
                            ? "destructivePlain"
                            : "warningPlain"
                      }
                    >
                      {row.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.attempts}</TableCell>
                  <TableCell>
                    {row.scheduledAt ? (
                      <time dateTime={row.scheduledAt}>
                        {formatTimestampWithAge(row.scheduledAt)}
                      </time>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-md truncate">
                    {row.lastError ?? <span className="text-muted-foreground">None</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.state === "failed" ? (
                      <form action={retryDestructiveOperationAction.bind(null, orgSlug, row.id)}>
                        <Button size="sm" type="submit" variant="outline">
                          <RefreshCwIcon aria-hidden="true" />
                          Retry
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
