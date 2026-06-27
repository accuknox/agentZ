import type { Metadata } from "next"
import { getProcessTelemetryAction } from "@/data/lens.actions"
import type { ProcessTelemetryActionData } from "@/data/types"
import { ProcessTelemetryTable } from "@/app/(app)/lens/runtime-telemetry/process-telemetry-table"
import {
  RuntimeTelemetryPage as RuntimeTelemetryPageContent,
  type TelemetryPageConfig,
} from "@/app/(app)/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Runtime Telemetry",
}

export default function RuntimeTelemetryPage({
  searchParams,
}: {
  searchParams: Promise<{
    agent_name?: string | string[]
    from?: string | string[]
    to?: string | string[]
    telemetry_page_token?: string | string[]
  }>
}) {
  const config: TelemetryPageConfig<ProcessTelemetryActionData> = {
    value: "process",
    headers: ["Process", "Command", "Action", "Occurrences", "Last Seen"],
    loadAction: getProcessTelemetryAction,
    renderTable: (data) => <ProcessTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPageContent searchParams={searchParams} config={config} />
}
