"use client"

import type { NetworkTelemetryActionData, NetworkTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  type TelemetryTableColumn,
} from "@/app/(app)/lens/runtime-telemetry/telemetry-table"
import { useTelemetryPagination } from "@/app/(app)/lens/runtime-telemetry/use-telemetry-pagination"

const columns: TelemetryTableColumn<NetworkTelemetryRow>[] = [
  {
    key: "destinationDomain",
    header: "Destination Domain",
    className: "min-w-52",
    render: (row) => <span className="font-mono text-xs">{row.destinationDomain}</span>,
  },
  {
    key: "destinationIP",
    header: "Destination IP",
    className: "min-w-40",
    render: (row) => <span className="font-mono text-xs">{row.destinationIP}</span>,
  },
  {
    key: "destinationPort",
    header: "Destination Port",
    className: "min-w-32",
    render: (row) => <span className="font-mono text-xs">{row.destinationPort}</span>,
  },
  {
    key: "protocol",
    header: "Protocol",
    className: "min-w-32",
    render: (row) => <span className="font-mono text-xs">{row.protocol}</span>,
  },
  { key: "action", header: "Action", render: (row) => <ActionBadge action={row.action} /> },
  {
    key: "occurrences",
    header: "Occurrences",
    className: "text-right",
    render: (row) => (
      <span className="text-right font-mono text-xs">{row.occurrences.toLocaleString()}</span>
    ),
  },
  {
    key: "lastSeen",
    header: "Last Seen",
    className: "min-w-40",
    render: (row) => <span className="text-muted-foreground text-sm">{row.lastSeen}</span>,
  },
]

export function NetworkTelemetryTable({ data }: { data: NetworkTelemetryActionData }) {
  const { pending, canGoPrevious, goNext, goPrevious } = useTelemetryPagination()

  return (
    <TelemetryTable
      data={data.rows}
      columns={columns}
      emptyText="No network events found"
      hasNextPage={data.hasNextPage}
      nextPageToken={data.nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={goNext}
      onPreviousPage={goPrevious}
      pending={pending}
    />
  )
}
