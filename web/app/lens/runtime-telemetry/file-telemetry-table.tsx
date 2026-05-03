"use client"

import type { FileTelemetryActionData, FileTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  type TelemetryTableColumn,
} from "@/app/lens/runtime-telemetry/telemetry-table"
import { useTelemetryPagination } from "@/app/lens/runtime-telemetry/use-telemetry-pagination"

const columns: TelemetryTableColumn<FileTelemetryRow>[] = [
  {
    key: "filePath",
    header: "File Path Accessed",
    className: "min-w-80",
    render: (row) => (
      <span className="max-w-[28rem] whitespace-normal break-all font-mono text-xs">
        {row.filePath}
      </span>
    ),
  },
  {
    key: "process",
    header: "Process",
    className: "min-w-72",
    render: (row) => (
      <span className="max-w-[28rem] whitespace-normal break-all font-mono text-xs">
        {row.process}
      </span>
    ),
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
    render: (row) => <span className="text-sm text-muted-foreground">{row.lastSeen}</span>,
  },
]

export function FileTelemetryTable({ data }: { data: FileTelemetryActionData }) {
  const { pending, canGoPrevious, goNext, goPrevious } = useTelemetryPagination()

  return (
    <TelemetryTable
      data={data.rows}
      columns={columns}
      emptyText="No file events found"
      hasNextPage={data.hasNextPage}
      nextPageToken={data.nextPageToken}
      canGoPrevious={canGoPrevious}
      onNextPage={goNext}
      onPreviousPage={goPrevious}
      pending={pending}
    />
  )
}
