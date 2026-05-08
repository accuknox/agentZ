import { getProcessTelemetryAction } from "@/data/lens.actions"
import type { ProcessTelemetryActionData } from "@/data/types"
import { ProcessTelemetryTable } from "@/app/lens/runtime-telemetry/process-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
} from "@/app/lens/runtime-telemetry/runtime-telemetry-page"

export default function ProcessPage({
  searchParams,
}: {
  searchParams: Promise<{
    session_id?: string | string[]
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

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
