import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"
import { AdministrationPageHeader } from "@/components/administration"
import { TelemetryChartSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-chart-skeleton"
import { TelemetryTableSkeleton } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table-skeleton"

export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-6 p-0">
      <AdministrationPageHeader title="Runtime Telemetry" />
      <div className="flex min-w-0 flex-1 flex-col gap-0">
        <div className="flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:px-6">
          <Skeleton className="h-8 w-full sm:w-64" />
          <Skeleton className="h-8 w-full sm:w-72" />
        </div>
        <Tabs value="process" className="flex flex-1 flex-col">
          <div className="border-b px-4 py-2 sm:px-6">
            <TabsList className="h-8 gap-1">
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
      </div>
    </main>
  )
}
