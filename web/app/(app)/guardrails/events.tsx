"use client"

import { useSearchParams } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { GuardrailEvent, ListGuardrailEventsResponse } from "@/lib/gateway/client"
import { getGuardrailEvent } from "@/lib/gateway/client"
import { getGuardrailEventOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { AdminDataGrid } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { formatTimestamp } from "@/lib/format"

import { GuardrailEventDetail, GuardrailEventSkeleton } from "./guardrail-event-detail"
import { contentScopes, detectors, verdicts } from "./event-shared"

const column = createColumnHelper<GuardrailEvent>()

type GuardrailEventsProps = {
  data: ListGuardrailEventsResponse
  basePath: `/orgs/${string}/guardrails`
  workspaceId?: string
}

export function GuardrailEvents({ data, basePath, workspaceId }: GuardrailEventsProps) {
  "use no memo"
  const searchParams = useSearchParams()
  const eventId = searchParams.get("event") ?? ""
  const options = {
    path: { eventId },
    headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
  }
  const detail = useQuery(
    queryOptions({
      ...getGuardrailEventOptions(options),
      enabled: eventId !== "",
      placeholderData: data.events.find((event) => event.id === eventId),
      staleTime: Infinity,
      retry: false,
      queryFn: async ({ signal }) => {
        const result = await getGuardrailEvent({
          ...options,
          signal,
          baseUrl: await getGatewayBaseURL(),
          throwOnError: true,
        })
        return result.data
      },
    })
  )

  function selectEvent(id?: string) {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("event", id)
    else url.searchParams.delete("event")
    if (id) window.history.pushState(null, "", url)
    else window.history.replaceState(null, "", url)
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table manages its own row model.
  const table = useReactTable({
    data: data.events,
    getCoreRowModel: getCoreRowModel(),
    columns: [
      column.accessor("occurred_at", {
        header: "Time",
        cell: ({ row, getValue }) => (
          <button
            className="text-left hover:underline"
            onClick={(event) => {
              event.stopPropagation()
              selectEvent(row.original.id)
            }}
          >
            {formatTimestamp(getValue())}
          </button>
        ),
      }),
      column.display({
        id: "outcome",
        header: "Outcome",
        cell: ({ row }) => {
          const verdict = verdicts[row.original.evaluation.action]
          const failed = row.original.evaluation.context?.reason === "checker_error"
          return (
            <Badge variant={failed ? "warning" : verdict.variant}>
              <verdict.icon data-icon="inline-start" />
              {failed && row.original.evaluation.action === "reject"
                ? "Fail closed"
                : verdict.label}
            </Badge>
          )
        },
      }),
      column.display({
        id: "check",
        header: "Check",
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium">
              {row.original.evaluation.context?.checkName ||
                detectors[row.original.evaluation.guard] ||
                "Guardrail check"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {row.original.evaluation.context?.policyName}
            </span>
          </div>
        ),
      }),
      column.display({
        id: "content",
        header: "Content",
        cell: ({ row }) => {
          const { context, phase } = row.original.evaluation
          const scope =
            context?.matchedScope ?? (context?.scopes.length === 1 ? context.scopes[0] : undefined)
          if (scope)
            return scope === "conversation"
              ? phase === "request"
                ? "Chat messages"
                : "Assistant response"
              : contentScopes[scope]
          return phase === "request" ? "Model request" : "Model response"
        },
      }),
      column.display({
        id: "subject",
        header: "Source",
        cell: ({ row }) =>
          row.original.agent_name ||
          row.original.subject_name ||
          row.original.sandbox_name ||
          "External application",
      }),
    ],
  })

  return (
    <>
      <AdminDataGrid
        ariaLabel="Guardrail interventions"
        table={table}
        rows={data.events}
        emptyState={
          <AdministrationState
            kind="empty"
            title="No guardrail interventions in this range"
            description="Blocks, masks, audit findings, and guardrail failures appear here."
          />
        }
        layout={{
          occurred_at: { minWidth: 180 },
          outcome: { minWidth: 150 },
          check: { minWidth: 200 },
          content: { minWidth: 160 },
          subject: { minWidth: 160 },
        }}
        onRowActivate={(event) => selectEvent(event.id)}
        rowAriaLabel={(event) =>
          `Inspect ${event.evaluation.context?.checkName || "guardrail evaluation"} from ${formatTimestamp(event.occurred_at)}`
        }
        pagination={
          <TokenTablePagination
            hasNextPage={Boolean(data.next_cursor)}
            nextPageToken={data.next_cursor ?? ""}
            pageTokenKey="cursor"
          />
        }
      />
      <Sheet
        open={eventId !== ""}
        onOpenChange={(open) => {
          if (!open) selectEvent()
        }}
      >
        <SheetContent
          size="full"
          aria-describedby={undefined}
          className="gap-0 overflow-hidden sm:w-[min(880px,90vw)]"
        >
          <SheetHeader>
            <SheetTitle>Guardrail evaluation</SheetTitle>
          </SheetHeader>
          {detail.isPending ? <GuardrailEventSkeleton /> : null}
          {detail.error ? (
            <AdministrationState
              kind="failed"
              title="Event unavailable"
              description={detail.error.message}
            />
          ) : null}
          {detail.data ? (
            <GuardrailEventDetail
              key={detail.data.id}
              event={detail.data}
              basePath={basePath}
              workspaceId={workspaceId}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
