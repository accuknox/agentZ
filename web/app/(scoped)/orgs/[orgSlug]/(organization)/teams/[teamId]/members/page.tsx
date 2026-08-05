import { notFound } from "next/navigation"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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

export default async function TeamMembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label={`${team.name} members`}>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar size="sm">
                      <AvatarFallback>
                        {(member.name ?? member.email).slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate font-medium" title={member.name ?? member.email}>
                      {member.name ?? member.email}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="max-w-72 truncate" title={member.email}>
                  {member.email}
                </TableCell>
                <TableCell>Active</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
