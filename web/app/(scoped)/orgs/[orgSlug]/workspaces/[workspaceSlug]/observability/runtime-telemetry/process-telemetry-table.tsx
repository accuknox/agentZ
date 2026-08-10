"use client"

import type { ProcessTelemetryActionData, ProcessTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  TruncateCell,
  type TelemetryTableColumn,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/telemetry-table"
import { useTelemetryPagination } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/observability/runtime-telemetry/use-telemetry-pagination"

const columns: TelemetryTableColumn<ProcessTelemetryRow>[] = [
  {
    key: "process",
    header: "Process",
    className: "min-w-36 max-w-64",
    render: (row) => <TruncateCell value={row.process} />,
  },
  {
    key: "command",
    header: "Command",
    className: "min-w-80 max-w-112",
    render: (row) => <TruncateCell value={row.command} />,
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

export function ProcessTelemetryTable({ data }: { data: ProcessTelemetryActionData }) {
  const { pending, canGoPrevious, goNext, goPrevious } = useTelemetryPagination()

  return (
    <TelemetryTable
      data={data.rows}
      columns={columns}
      emptyText="No process events found"
      hasNextPage={data.hasNextPage}
      nextPageToken={data.nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={goNext}
      onPreviousPage={goPrevious}
      pending={pending}
    />
  )
}
