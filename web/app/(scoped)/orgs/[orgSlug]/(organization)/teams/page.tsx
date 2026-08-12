import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { RoutedTableRow } from "@/components/routed-table-row"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listTeams } from "@/data/teams"
import { formatAge } from "@/lib/format"

export default async function TeamsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const data = await listTeams(orgSlug)
  if (!data) return <AdministrationState kind="forbidden" />
  const root = `/orgs/${orgSlug}/teams`

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <Button asChild>
            <Link href={`${root}/new` as Route}>
              <Plus />
              Create team
            </Link>
          </Button>
        }
        title="Teams"
      />
      <div className="w-full min-w-0 border-b">
        <Table aria-label="Teams" className="w-full table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-28 text-right">Members</TableHead>
              <TableHead className="w-24 text-right">Roles</TableHead>
              <TableHead className="w-32 text-right">Workspaces</TableHead>
              <TableHead className="w-32">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.teams.length ? (
              data.teams.map((team) => (
                <RoutedTableRow
                  aria-label={`Open ${team.name}`}
                  href={`${root}/${team.id}` as Route}
                  key={team.id}
                >
                  <TableCell className="max-w-72">
                    <span className="block truncate font-medium" title={team.name}>
                      {team.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{team.memberCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{team.roleCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {team.accessibleWorkspaceCount}
                  </TableCell>
                  <TableCell>
                    <time dateTime={team.updatedAt}>{formatAge(team.updatedAt)}</time>
                  </TableCell>
                </RoutedTableRow>
              ))
            ) : (
              <TableRow>
                <TableCell className="h-24 text-center" colSpan={5}>
                  No teams
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
