import { RefreshCwIcon } from "lucide-react"
import { retryDestructiveOperationAction } from "@/app/(scoped)/orgs/actions"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
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
import { formatAge } from "@/lib/format"

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
      <div className="w-full min-w-0 border-b">
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
            {data.rows.length ? (
              data.rows.map((row) => (
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
                          ? "success"
                          : row.state === "failed"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {row.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.attempts}</TableCell>
                  <TableCell>
                    {row.scheduledAt ? (
                      <time dateTime={row.scheduledAt}>{formatAge(row.scheduledAt)}</time>
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
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={8}>
                  No operations
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
