import { notFound } from "next/navigation"
import { UserIdentity } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getTeamDetail } from "@/data/teams"

export const metadata = { title: "Members" }

export default async function TeamMembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  return (
    <div className="w-full min-w-0 border-b">
      <Table aria-label={`${team.name} members`}>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {team.members.length ? (
            team.members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <UserIdentity email={member.email} image={member.image} name={member.name} />
                </TableCell>
                <TableCell className="max-w-72 truncate" title={member.email}>
                  {member.email}
                </TableCell>
                <TableCell>
                  <Badge variant="success">Active</Badge>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={3}>
                <span className="text-muted-foreground">_</span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
