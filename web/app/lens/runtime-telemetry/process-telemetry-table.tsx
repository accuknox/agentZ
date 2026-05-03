"use client"

import type { ProcessTelemetryRow } from "@/data/types"
import {
  TelemetryTable,
  ActionBadge,
  type TelemetryTableColumn,
} from "@/app/lens/runtime-telemetry/telemetry-table"

const columns: TelemetryTableColumn<ProcessTelemetryRow>[] = [
  {
    key: "process",
    header: "Process",
    className: "min-w-36",
    render: (row) => <span className="font-mono text-xs">{row.process}</span>,
  },
  {
    key: "command",
    header: "Command",
    className: "min-w-80",
    render: (row) => (
      <span className="max-w-[28rem] whitespace-normal break-all font-mono text-xs">
        {row.command}
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

export function ProcessTelemetryTable({ data }: { data: ProcessTelemetryRow[] }) {
  return <TelemetryTable data={data} columns={columns} emptyText="No process events found" />
}
