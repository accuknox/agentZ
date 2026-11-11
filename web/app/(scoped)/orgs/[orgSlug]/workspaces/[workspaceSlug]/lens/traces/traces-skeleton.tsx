import { Skeleton } from "@/components/ui/skeleton"
import type { LensSubject } from "@/data/types"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export async function TracesSkeleton({
  subject,
}: {
  subject?: LensSubject | Promise<LensSubject | undefined>
} = {}) {
  const selected = await subject
  const copilotStudio =
    selected?.kind === "external-agent" && selected.providerKind === "microsoft-copilot-studio"
  return (
    <div className="flex flex-col">
      <div className="border-b bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-40">Trace</TableHead>
              {copilotStudio ? (
                <TableHead className="min-w-40">Last observed</TableHead>
              ) : (
                <TableHead className="min-w-52">Duration</TableHead>
              )}
              <TableHead className="min-w-72">{copilotStudio ? "Activity" : "Execution"}</TableHead>
              {copilotStudio ? null : <TableHead className="min-w-48">Tokens</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, row) => (
              <TableRow key={row}>
                <TableCell className="h-12">
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </TableCell>
                <TableCell className="h-12">
                  {copilotStudio ? (
                    <Skeleton className="h-4 w-24" />
                  ) : (
                    <div className="flex flex-col gap-1">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  )}
                </TableCell>
                <TableCell className="h-12">
                  <div className="flex gap-1.5">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                    {copilotStudio ? null : <Skeleton className="h-5 w-20 rounded-full" />}
                    <Skeleton className="h-5 w-18 rounded-full" />
                  </div>
                </TableCell>
                {copilotStudio ? null : (
                  <TableCell className="h-12">
                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-1.5 w-40 rounded-full" />
                    </div>
                  </TableCell>
                )}
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
