import type { Metadata } from "next"
import { getNetworkTelemetryAction } from "@/data/lens.actions"
import type { NetworkTelemetryActionData } from "@/data/types"
import { NetworkTelemetryTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/network-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
  type TelemetrySearchParams,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Network Telemetry",
}

export default function NetworkPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
  searchParams: Promise<TelemetrySearchParams>
}) {
  const config: TelemetryPageConfig<NetworkTelemetryActionData> = {
    value: "network",
    headers: [
      "Destination Domain",
      "Destination IP",
      "Destination Port",
      "Protocol",
      "Action",
      "Occurrences",
      "Last Seen",
    ],
    loadAction: getNetworkTelemetryAction,
    renderTable: (data) => <NetworkTelemetryTable data={data} />,
  }

  return <RuntimeTelemetryPage params={params} searchParams={searchParams} config={config} />
}
