import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface TelemetryTableSkeletonProps {
  headers: string[]
  rowCount?: number
  showFooter?: boolean
}

const headerClasses: Record<string, string> = {
  "File Path Accessed": "min-w-80",
  Process: "min-w-36",
  Command: "min-w-80",
  Action: "",
  Occurrences: "text-right",
  "Last Seen": "min-w-40",
  "Destination Domain": "min-w-52",
  "Destination IP": "min-w-40",
  "Destination Port": "min-w-32",
  Protocol: "min-w-32",
}

const headerWidths: Record<string, string> = {
  "File Path Accessed": "w-32",
  Process: "w-20",
  Command: "w-24",
  Action: "w-16",
  Occurrences: "w-24",
  "Last Seen": "w-20",
  "Destination Domain": "w-32",
  "Destination IP": "w-24",
  "Destination Port": "w-24",
  Protocol: "w-16",
}

export function TelemetryTableSkeleton({
  headers,
  rowCount = 8,
  showFooter = true,
}: TelemetryTableSkeletonProps) {
  const rows = Array.from({ length: rowCount }, (_, index) => index)

  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto border-b">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((header) => {
                const headerClass = headerClasses[header] || ""
                const headerWidth = headerWidths[header] || "w-20"
                return (
                  <TableHead key={header} className={headerClass}>
                    <Skeleton className={cn("h-4", headerWidth)} />
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row}>
                {headers.map((header, index) => {
                  const cellClass = headerClasses[header] || ""
                  return (
                    <TableCell key={index} className={cellClass}>
                      <Skeleton className="h-4 w-full max-w-50" />
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {showFooter ? (
        <div className="bg-muted/10 flex w-full flex-col gap-2 px-6 py-3 md:flex-row md:items-center md:justify-between">
          <Skeleton className="h-4 w-24" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
