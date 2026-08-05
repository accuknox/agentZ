import { notFound } from "next/navigation"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
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
import { formatTimestampWithAge } from "@/lib/format"

export default async function TeamActivityPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  if (team.activity.length === 0)
    return (
      <AdministrationState
        description="Membership, Role, and Team changes will appear here."
        kind="empty"
        title="No Team activity"
      />
    )

  return (
    <Card>
      <CardContent className="px-0">
        <Table aria-label={`${team.name} activity`}>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.activity.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <time dateTime={event.createdAt}>{formatTimestampWithAge(event.createdAt)}</time>
                </TableCell>
                <TableCell className="max-w-64 truncate" title={event.actorName}>
                  {event.actorName}
                </TableCell>
                <TableCell className="font-mono text-sm">{event.action}</TableCell>
                <TableCell>
                  <Badge variant={event.result === "succeeded" ? "success" : "destructive"}>
                    {event.result}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
