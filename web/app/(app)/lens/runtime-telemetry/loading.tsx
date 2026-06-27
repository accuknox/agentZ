import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"
import { TelemetryChartSkeleton } from "@/app/(app)/lens/runtime-telemetry/telemetry-chart-skeleton"
import { TelemetryTableSkeleton } from "@/app/(app)/lens/runtime-telemetry/telemetry-table-skeleton"

export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <div className="flex items-center justify-between px-6">
        <Skeleton className="h-6 w-36" />
      </div>
      <div className="bg-muted/20 h-15 border-b" />
      <Tabs value="process" className="flex flex-1 flex-col">
        <div className="border-b px-6">
          <TabsList variant="line" className="h-10 gap-4">
            <div className="flex h-6 items-center gap-4">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-6 w-16" />
              <Skeleton className="h-6 w-20" />
            </div>
          </TabsList>
        </div>
        <div className="flex flex-1 flex-col">
          <TabsContent value="process" className="m-0 flex flex-1 flex-col">
            <TelemetryChartSkeleton />
            <TelemetryTableSkeleton
              headers={["Process", "Command", "Action", "Occurrences", "Last Seen"]}
            />
          </TabsContent>
        </div>
      </Tabs>
    </main>
  )
}
