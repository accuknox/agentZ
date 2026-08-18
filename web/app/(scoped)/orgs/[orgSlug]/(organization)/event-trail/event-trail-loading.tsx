import { AdministrationPageHeader } from "@/components/administration"
import { EventsChartSkeleton } from "@/components/events-chart-skeleton"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function EventTrailLoading({ workspace = false }: { workspace?: boolean }) {
  return (
    <div aria-label="Loading event trail events" className="flex min-w-0 flex-col" role="status">
      <span className="sr-only">Loading event trail events...</span>
      <AdministrationPageHeader title="Event Trail" />
      <div className="mt-4 flex min-h-12 items-center gap-1.5 border-b px-4 py-2 md:px-6">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-20" />
      </div>
      <EventsChartSkeleton />
      <div className="w-full min-w-0">
        <Table aria-label="Loading event trail table">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead className="hidden md:table-cell">Actor</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Target</TableHead>
              {!workspace ? (
                <TableHead className="hidden lg:table-cell">Workspace</TableHead>
              ) : null}
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }, (_, index) => (
              <TableRow key={index}>
                <TableCell className="min-w-36">
                  <Skeleton className="h-3 w-20" />
                </TableCell>
                <TableCell className="hidden max-w-56 md:table-cell">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="mt-1.5 h-3 w-14" />
                </TableCell>
                <TableCell className="min-w-48">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="mt-1.5 h-3 w-24 md:hidden" />
                </TableCell>
                <TableCell className="max-w-56">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="mt-1.5 h-3 w-16" />
                </TableCell>
                {!workspace ? (
                  <TableCell className="hidden max-w-56 lg:table-cell">
                    <Skeleton className="h-3.5 w-28" />
                  </TableCell>
                ) : null}
                <TableCell>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex justify-end gap-1 py-3 pr-4 md:pr-6">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
    </div>
  )
}
