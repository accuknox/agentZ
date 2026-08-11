import type { Route } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
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
        <Table aria-label="Teams">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Roles</TableHead>
              <TableHead className="text-right">Workspaces</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.teams.length ? (
              data.teams.map((team) => (
                <TableRow key={team.id}>
                  <TableCell className="max-w-72">
                    <Link
                      className="block truncate font-medium hover:underline"
                      href={`${root}/${team.id}` as Route}
                      title={team.name}
                    >
                      {team.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{team.memberCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{team.roleCount}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {team.accessibleWorkspaceCount}
                  </TableCell>
                  <TableCell>
                    <time dateTime={team.updatedAt}>{formatAge(team.updatedAt)}</time>
                  </TableCell>
                </TableRow>
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
