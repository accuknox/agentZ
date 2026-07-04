import type { Metadata } from "next"
import { getProcessTelemetryAction } from "@/data/lens.actions"
import type { ProcessTelemetryActionData } from "@/data/types"
import { ProcessTelemetryTable } from "@/app/(app)/lens/runtime-telemetry/process-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
  type TelemetrySearchParams,
} from "@/app/(app)/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Process Telemetry",
}

export default function ProcessPage({
  searchParams,
}: {
  searchParams: Promise<TelemetrySearchParams>
}) {
  const config: TelemetryPageConfig<ProcessTelemetryActionData> = {
    value: "process",
    headers: ["Process", "Command", "Action", "Occurrences", "Last Seen"],
    loadAction: getProcessTelemetryAction,
    renderTable: (data) => <ProcessTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
