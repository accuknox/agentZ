import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function TracesSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="bg-background overflow-x-auto border-b">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[20%] min-w-40">Trace</TableHead>
              <TableHead className="w-[22%] min-w-52">Duration</TableHead>
              <TableHead className="w-[36%] min-w-72">Execution</TableHead>
              <TableHead className="w-[22%] min-w-48">Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, row) => (
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
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-20 rounded-full" />
                    <Skeleton className="h-5 w-18 rounded-full" />
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
      <div className="flex h-12 w-full items-center gap-3 px-6">
        <Skeleton className="h-4 w-16" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    </div>
  )
}
