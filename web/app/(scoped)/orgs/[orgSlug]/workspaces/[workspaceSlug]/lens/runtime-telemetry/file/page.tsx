import type { Metadata } from "next"
import { getFileTelemetryAction } from "@/data/lens.actions"
import type { FileTelemetryActionData } from "@/data/types"
import { FileTelemetryTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/file-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
  type TelemetrySearchParams,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "File Telemetry",
}

export default function FilePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<TelemetrySearchParams>
}) {
  const config: TelemetryPageConfig<FileTelemetryActionData> = {
    value: "file",
    headers: ["File Path Accessed", "Process", "Action", "Occurrences", "Last Seen"],
    loadAction: getFileTelemetryAction,
    renderTable: (data) => <FileTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPage params={params} searchParams={searchParams} config={config} />
}
