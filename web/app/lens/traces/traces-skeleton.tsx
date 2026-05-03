import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const rows = Array.from({ length: 8 }, (_, index) => index)
const headers = ["Trace", "Duration", "Execution", "Tokens"]

export function TracesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row}>
                <TableCell className="h-16">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                </TableCell>
                <TableCell className="h-16">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </TableCell>
                <TableCell className="h-16">
                  <div className="flex gap-1.5">
                    <Skeleton className="h-5 w-16 rounded-4xl" />
                    <Skeleton className="h-5 w-16 rounded-4xl" />
                    <Skeleton className="h-5 w-20 rounded-4xl" />
                    <Skeleton className="h-5 w-18 rounded-4xl" />
                  </div>
                </TableCell>
                <TableCell className="h-16">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-1.5 w-40 rounded-full" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between px-1">
        <Skeleton className="h-3 w-14" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    </div>
  )
}
