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
import { formatTimestampWithAge } from "@/lib/format"

export default async function TeamsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params
  const data = await listTeams(orgSlug)
  if (!data) return <AdministrationState kind="forbidden" />
  const root = `/orgs/${orgSlug}/teams`

  if (data.teams.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <AdministrationPageHeader title="Teams" />
        <AdministrationState
          actions={
            <Button asChild>
              <Link href={`${root}/new` as Route}>
                <Plus />
                Create Team
              </Link>
            </Button>
          }
          kind="empty"
          title="No Teams yet"
        />
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <Button asChild>
            <Link href={`${root}/new` as Route}>
              <Plus />
              Create Team
            </Link>
          </Button>
        }
        title="Teams"
      />
      <div className="border-y">
        <Table aria-label="Teams">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Roles</TableHead>
              <TableHead className="text-right">Accessible Workspaces</TableHead>
              <TableHead className="text-right">Shared Agents</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.teams.map((team) => (
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
                <TableCell className="text-right tabular-nums">0</TableCell>
                <TableCell>
                  <time dateTime={team.updatedAt}>{formatTimestampWithAge(team.updatedAt)}</time>
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`${root}/${team.id}` as Route}>Manage</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
