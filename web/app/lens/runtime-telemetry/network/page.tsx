import { getNetworkTelemetryAction } from "@/data/lens.actions"
import type { NetworkTelemetryActionData } from "@/data/types"
import { NetworkTelemetryTable } from "@/app/lens/runtime-telemetry/network-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
} from "@/app/lens/runtime-telemetry/runtime-telemetry-page"

export default function NetworkPage({
  searchParams,
}: {
  searchParams: Promise<{
    agent_name?: string | string[]
    from?: string | string[]
    to?: string | string[]
    telemetry_page_token?: string | string[]
  }>
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

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
