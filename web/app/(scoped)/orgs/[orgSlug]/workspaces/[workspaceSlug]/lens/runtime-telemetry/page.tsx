import type { Metadata } from "next"
import { getProcessTelemetryAction } from "@/data/lens.actions"
import type { ProcessTelemetryActionData } from "@/data/types"
import { ProcessTelemetryTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/process-telemetry-table"
import {
  RuntimeTelemetryPage as RuntimeTelemetryPageContent,
  type TelemetryPageConfig,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Runtime Telemetry",
}

export default function RuntimeTelemetryPage({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry">) {
  const config: TelemetryPageConfig<ProcessTelemetryActionData> = {
    value: "process",
    headers: ["Process", "Command", "Action", "Occurrences", "Last Seen"],
    loadAction: getProcessTelemetryAction,
    renderTable: (data) => <ProcessTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPageContent params={params} searchParams={searchParams} config={config} />
}
