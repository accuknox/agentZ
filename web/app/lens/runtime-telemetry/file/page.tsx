import { getFileTelemetryAction } from "@/data/lens.actions"
import type { FileTelemetryActionData } from "@/data/types"
import { FileTelemetryTable } from "@/app/lens/runtime-telemetry/file-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
} from "@/app/lens/runtime-telemetry/runtime-telemetry-page"

export default function FilePage({
  searchParams,
}: {
  searchParams: Promise<{
    agent_name?: string | string[]
    from?: string | string[]
    to?: string | string[]
    telemetry_page_token?: string | string[]
  }>
}) {
  const config: TelemetryPageConfig<FileTelemetryActionData> = {
    value: "file",
    headers: ["File Path Accessed", "Process", "Action", "Occurrences", "Last Seen"],
    loadAction: getFileTelemetryAction,
    renderTable: (data) => <FileTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
