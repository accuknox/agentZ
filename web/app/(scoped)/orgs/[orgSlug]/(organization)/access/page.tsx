import Link from "next/link"
import type { Route } from "next"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
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
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label="Effective Access">
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Direct Roles</TableHead>
            <TableHead className="text-right">Team Roles</TableHead>
            <TableHead className="text-right">Owned</TableHead>
            <TableHead className="text-right">Shared</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow key={row.memberId}>
                <TableCell className="max-w-64">
                  <Link
                    className="block truncate font-medium hover:underline"
                    href={`/orgs/${orgSlug}/access/${row.memberId}` as Route}
                    title={row.user}
                  >
                    {row.user}
                  </Link>
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
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={6}>
                No organization members
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
