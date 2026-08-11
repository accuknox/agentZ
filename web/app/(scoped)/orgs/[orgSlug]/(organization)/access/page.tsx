import Link from "next/link"
import type { Route } from "next"
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
import { listEffectiveAccess } from "@/data/access"

export default async function AccessPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const data = await listEffectiveAccess(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Access" />
      <AccessTable orgSlug={orgSlug} rows={data.rows} />
    </div>
  )
}

function AccessTable({
  orgSlug,
  rows,
}: {
  orgSlug: string
  rows: NonNullable<Awaited<ReturnType<typeof listEffectiveAccess>>>["rows"]
}) {
  if (rows.length === 0) {
    return <AdministrationState kind="empty" title="No Organisation Members" />
  }

  return (
    <div className="border-y">
      <Table aria-label="Effective Access">
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Direct Roles</TableHead>
            <TableHead className="text-right">Team Roles</TableHead>
            <TableHead className="text-right">Owned</TableHead>
            <TableHead className="text-right">Shared</TableHead>
            <TableHead>Explanation</TableHead>
            <TableHead className="text-right">Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.memberId}>
              <TableCell className="max-w-64">
                <div className="truncate font-medium" title={row.user}>
                  {row.user}
                </div>
                <div className="text-muted-foreground truncate text-xs" title={row.email}>
                  {row.email}
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    row.status === "active"
                      ? "successPlain"
                      : row.status === "disabled"
                        ? "destructivePlain"
                        : "warningPlain"
                  }
                >
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.directRoles}</TableCell>
              <TableCell className="text-right tabular-nums">{row.teamRoles}</TableCell>
              <TableCell className="text-right tabular-nums">{row.ownedAgents}</TableCell>
              <TableCell className="text-right tabular-nums">{row.sharedAgents}</TableCell>
              <TableCell className="max-w-md text-sm">{row.explanation}</TableCell>
              <TableCell className="text-right">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/orgs/${orgSlug}/access/${row.memberId}` as Route}>View</Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
