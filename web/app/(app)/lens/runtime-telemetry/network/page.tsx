import type { Metadata } from "next"
import { getNetworkTelemetryAction } from "@/data/lens.actions"
import type { NetworkTelemetryActionData } from "@/data/types"
import { NetworkTelemetryTable } from "@/app/(app)/lens/runtime-telemetry/network-telemetry-table"
import {
  RuntimeTelemetryPage,
  type TelemetryPageConfig,
  type TelemetrySearchParams,
} from "@/app/(app)/lens/runtime-telemetry/runtime-telemetry-page"

export const metadata: Metadata = {
  title: "Network Telemetry",
}

export default function NetworkPage({
  searchParams,
}: {
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

  return <RuntimeTelemetryPage searchParams={searchParams} config={config} />
}
