"use client"

import type { NetworkTelemetryActionData, NetworkTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  type TelemetryTableColumn,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table"
import { useTelemetryPagination } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/use-telemetry-pagination"

const columns: TelemetryTableColumn<NetworkTelemetryRow>[] = [
  {
    key: "destinationDomain",
    header: "Destination domain",
    layout: { minWidth: 208, contentMaxWidth: 320 },
    render: (row) => <span className="font-mono text-xs">{row.destinationDomain}</span>,
  },
  {
    key: "destinationIP",
    header: "Destination IP",
    layout: { minWidth: 160, width: 160 },
    render: (row) => <span className="font-mono text-xs">{row.destinationIP}</span>,
  },
  {
    key: "destinationPort",
    header: "Destination port",
    layout: { minWidth: 128, width: 128 },
    render: (row) => <span className="font-mono text-xs">{row.destinationPort}</span>,
  },
  {
    key: "protocol",
    header: "Protocol",
    layout: { minWidth: 128, width: 128 },
    render: (row) => <span className="font-mono text-xs">{row.protocol}</span>,
  },
  {
    key: "action",
    header: "Action",
    layout: { minWidth: 112, width: 112 },
    render: (row) => <ActionBadge action={row.action} />,
  },
  {
    key: "occurrences",
    header: "Occurrences",
    layout: { minWidth: 112, width: 112, align: "end" },
    render: (row) => (
      <span className="text-right font-mono text-xs">{row.occurrences.toLocaleString()}</span>
    ),
  },
  {
    key: "lastSeen",
    header: "Last seen",
    layout: { minWidth: 160, width: 160 },
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
