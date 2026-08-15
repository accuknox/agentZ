import { notFound } from "next/navigation"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getTeamDetail } from "@/data/teams"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { formatAge } from "@/lib/format"
import { ResultBadge } from "../../../event-trail/event-trail-event"

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
                  <time dateTime={event.createdAt}>{formatAge(event.createdAt)}</time>
                </TableCell>
                <TableCell className="max-w-64" title={event.actorName}>
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar size="sm">
                      <AvatarImage alt="" src={event.actorImage ?? undefined} />
                      <AvatarFallback>{event.actorName.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate">{event.actorName}</span>
                  </div>
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
