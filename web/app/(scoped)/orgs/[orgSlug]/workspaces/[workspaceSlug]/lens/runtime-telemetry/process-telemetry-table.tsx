"use client"

import type { ProcessTelemetryActionData, ProcessTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  TruncateCell,
  type TelemetryTableColumn,
} from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/telemetry-table"
import { useTelemetryPagination } from "@/app/(scoped)/orgs/[orgSlug]/workspaces/[workspaceSlug]/lens/runtime-telemetry/use-telemetry-pagination"

const columns: TelemetryTableColumn<ProcessTelemetryRow>[] = [
  {
    key: "process",
    header: "Process",
    layout: { minWidth: 144, contentMaxWidth: 256 },
    render: (row) => <TruncateCell value={row.process} />,
  },
  {
    key: "command",
    header: "Command",
    layout: { minWidth: 320, contentMaxWidth: 448 },
    render: (row) => <TruncateCell value={row.command} />,
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
