import type { Metadata } from "next"
import { getFileTelemetryAction } from "@/data/lens.actions"
import type { FileTelemetryActionData } from "@/data/types"
import { FileTelemetryTable } from "@/app/(app)/lens/runtime-telemetry/file-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
  type TelemetrySearchParams,
} from "@/app/(app)/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "File Telemetry",
}

export default function FilePage({
  searchParams,
}: {
  searchParams: Promise<TelemetrySearchParams>
}) {
  const config: TelemetryPageConfig<FileTelemetryActionData> = {
    value: "file",
    headers: ["File Path Accessed", "Process", "Action", "Occurrences", "Last Seen"],
    loadAction: getFileTelemetryAction,
    renderTable: (data) => <FileTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
