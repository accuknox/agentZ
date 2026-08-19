import { notFound } from "next/navigation"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  RelativeDateTime,
  TableRow,
} from "@/components/ui/table"
import { getTeamDetail } from "@/data/teams"
import { UserIdentity } from "@/components/ui/avatar"
import { ResultBadge } from "../../../event-trail/event-trail-event"

export const metadata = { title: "Activity" }

export default async function TeamActivityPage({
  params,
}: {
  params: Promise<{ orgSlug: string; teamId: string }>
}) {
  const { orgSlug, teamId } = await params
  const team = await getTeamDetail(orgSlug, teamId)
  if (!team) notFound()
  return (
    <div className="w-full min-w-0 border-b">
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
          {team.activity.length ? (
            team.activity.map((event) => (
              <TableRow key={event.id}>
                <TableCell>
                  <RelativeDateTime value={event.createdAt} />
                </TableCell>
                <TableCell className="max-w-64" title={event.actorName}>
                  <UserIdentity image={event.actorImage} name={event.actorName} secondary={false} />
                </TableCell>
                <TableCell className="font-mono text-sm">{event.action}</TableCell>
                <TableCell>
                  <ResultBadge result={event.result} />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-24 text-center" colSpan={4}>
                <span className="text-muted-foreground">_</span>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
