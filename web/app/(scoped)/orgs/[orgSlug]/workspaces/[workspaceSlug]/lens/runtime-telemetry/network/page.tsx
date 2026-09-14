import type { Metadata } from "next"
import { getNetworkTelemetryAction } from "@/data/lens.actions"
import type { NetworkTelemetryActionData } from "@/data/types"
import { NetworkTelemetryTable } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/network-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Network Telemetry",
}

export default function NetworkPage({
  params,
  searchParams,
}: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/network">) {
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
