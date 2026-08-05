import { notFound } from "next/navigation"
import { AccessSourceChip } from "@/components/administration"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getTeamDetail } from "@/data/teams"

export default async function TeamRolesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Every member receives the additive union of these Roles. Direct assignments remain
        independent.
      </p>
      <Card>
        <CardContent className="px-0">
          <Table aria-label={`${team.name} Roles`}>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">{role.name}</TableCell>
                  <TableCell>{role.scope}</TableCell>
                  <TableCell>
                    <AccessSourceChip source="Team Role" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
