"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { CheckCircle2, CircleAlert, Eye, ShieldX, WandSparkles, ArrowUpRight } from "lucide-react"
import type {
  GuardrailContext,
  GuardrailEvent,
  ListGuardrailEventsResponse,
} from "@/lib/gateway/client"
import { getGuardrailEvent } from "@/lib/gateway/client"
import { getGuardrailEventOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { AdminDataGrid } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { TokenTablePagination } from "@/components/table-pagination"
import { CopyButton } from "@/components/interior/copy-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTimestamp } from "@/lib/format"

const column = createColumnHelper<GuardrailEvent>()
const verdicts = {
  allow: { label: "Allowed", icon: CheckCircle2, variant: "success" },
  reject: { label: "Blocked", icon: ShieldX, variant: "destructive" },
  mask: { label: "Masked", icon: WandSparkles, variant: "secondary" },
  audit: { label: "Audit finding", icon: Eye, variant: "secondary" },
  failOpen: { label: "Allowed after checker error", icon: CircleAlert, variant: "warning" },
} as const

const detectors: Record<string, string> = {
  regex: "Regular expression",
  openAIModeration: "OpenAI Moderation",
  bedrockGuardrails: "AWS Bedrock Guardrails",
  googleModelArmor: "Google Model Armor",
  webhook: "Custom webhook",
}

const contentScopes: Record<GuardrailContext["scopes"][number], string> = {
  instructions: "System instructions",
  conversation: "Conversation",
  toolArguments: "Tool arguments",
  toolResults: "Tool results",
}

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
                ? "Checker unavailable"
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
              ? `Conversation ${phase === "request" ? "input" : "output"}`
              : contentScopes[scope]
          return phase === "request" ? "Input" : "Output"
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
        ariaLabel="Guardrail evaluations"
        table={table}
        rows={data.events}
        emptyState={
          <AdministrationState
            kind="empty"
            title="No evaluations in this range"
            description="Guardrail activity will appear here when a policy is evaluated."
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
        <SheetContent size="full" className="overflow-y-auto sm:w-[75vw] sm:max-w-6xl">
          <SheetHeader>
            <SheetTitle>Guardrail evaluation</SheetTitle>
            <SheetDescription>What was checked and how the policy handled it.</SheetDescription>
          </SheetHeader>
          {detail.isPending ? (
            <div className="flex flex-col gap-5 p-6">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : null}
          {detail.error ? (
            <AdministrationState
              kind="failed"
              title="Event unavailable"
              description={detail.error.message}
            />
          ) : null}
          {detail.data ? <GuardrailEventDetail event={detail.data} basePath={basePath} /> : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

function GuardrailEventDetail({
  event,
  basePath,
}: {
  event: GuardrailEvent
  basePath: `/orgs/${string}/guardrails`
}) {
  const searchParams = useSearchParams()
  const { evaluation } = event
  const { context } = evaluation
  const verdict = verdicts[evaluation.action]
  const failed = context?.reason === "checker_error"
  let title = "Content passed the guardrail"
  let explanation = "The check completed and allowed processing to continue."
  if (evaluation.action === "reject") {
    title = "Content blocked by policy"
    explanation = "Processing stopped because the check found restricted content."
  }
  if (evaluation.action === "mask") {
    title = "Sensitive content masked"
    explanation = "The check replaced matched content before processing continued."
  }
  if (evaluation.action === "audit") {
    title = "Policy finding recorded"
    explanation = "The check found restricted content. Audit mode allowed processing to continue."
  }
  if (failed) {
    title =
      evaluation.action === "reject"
        ? "Processing stopped because the checker was unavailable"
        : "Processing continued after a checker error"
    explanation =
      evaluation.action === "reject"
        ? "The checker could not evaluate this content. The policy requires processing to stop when a check fails."
        : "The checker could not evaluate this content. The policy allows processing to continue when a check fails."
  }
  const subject =
    event.agent_name || event.subject_name || event.sandbox_name || "External application"
  const matched = context?.matchedScope
  const scopes = matched ? [matched] : (context?.scopes ?? [])
  const related = new URLSearchParams({ trace_id: event.trace_id })
  for (const key of ["from", "to"]) {
    const value = searchParams.get(key)
    if (value) related.set(key, value)
  }
  if (!related.has("from"))
    related.set(
      "from",
      new Date(new Date(event.occurred_at).getTime() - 60 * 60 * 1000).toISOString()
    )
  if (!related.has("to"))
    related.set(
      "to",
      new Date(new Date(event.occurred_at).getTime() + 60 * 60 * 1000).toISOString()
    )
  const workspacePath = basePath.replace(/\/guardrails$/, "")

  return (
    <div className="flex min-w-0 flex-col gap-8 p-5 sm:p-8">
      <section className="flex flex-col gap-4 rounded-xl border bg-muted/20 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={failed ? "warning" : verdict.variant}>
            <verdict.icon data-icon="inline-start" />
            {failed && evaluation.action === "reject" ? "Checker unavailable" : verdict.label}
          </Badge>
          <Badge variant="outline">{evaluation.phase === "request" ? "Input" : "Output"}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">
            {formatTimestamp(event.occurred_at)}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="max-w-3xl text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
          <p className="max-w-3xl leading-relaxed text-muted-foreground">{explanation}</p>
        </div>
        {context?.message && !failed ? (
          <p className="border-l-2 border-primary/40 pl-4 leading-relaxed">{context.message}</p>
        ) : null}
      </section>
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <h3 className="font-medium">{failed ? "Content scope" : "Inspected content"}</h3>
          <div className="flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <Badge key={scope} variant="secondary">
                {scope === "conversation"
                  ? `Conversation ${evaluation.phase === "request" ? "input" : "output"}`
                  : contentScopes[scope]}
              </Badge>
            ))}
          </div>
          {!matched && scopes.length > 1 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              The detector evaluated these parts together and did not identify a single offending
              part.
            </p>
          ) : null}
          {!scopes.length ? (
            <p className="text-sm text-muted-foreground">
              {evaluation.phase === "request" ? "Model request" : "Model response"}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Event records contain evaluation metadata, not inspected content.
          </p>
        </section>
        <section className="flex flex-col gap-4">
          <h3 className="font-medium">Policy decision</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
            {context?.policyName ? (
              <>
                <dt className="text-muted-foreground">Policy</dt>
                <dd className="break-words">{context.policyName}</dd>
              </>
            ) : null}
            {context?.checkName ? (
              <>
                <dt className="text-muted-foreground">Check</dt>
                <dd className="break-words">{context.checkName}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Detector</dt>
            <dd>{detectors[evaluation.guard] || "Guardrail detector"}</dd>
          </dl>
          {context?.policyId ? (
            <Button asChild variant="outline" size="sm" className="self-start">
              <Link href={`${basePath}/policies`}>
                View policy
                <ArrowUpRight data-icon="inline-end" />
              </Link>
            </Button>
          ) : null}
        </section>
      </div>
      <section className="flex flex-col gap-4 border-t pt-6">
        <h3 className="font-medium">Request</h3>
        <dl className="grid gap-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="mt-1 font-medium break-words">{subject}</dd>
          </div>
          {event.model ? (
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="mt-1 font-medium break-words">{event.model}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">Time</dt>
            <dd className="mt-1">{formatTimestamp(event.occurred_at)}</dd>
          </div>
        </dl>
        {event.trace_id ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`${basePath}/events?${related}`}>
                Related evaluations
                <ArrowUpRight data-icon="inline-end" />
              </Link>
            </Button>
            {basePath.includes("/workspaces/") && (event.agent_name || event.client_id) ? (
              <Button asChild variant="outline" size="sm">
                <Link
                  href={{
                    pathname: `${workspacePath}/lens/traces`,
                    query: {
                      ...(event.agent_name
                        ? { agent_name: event.agent_name }
                        : { app_client_id: event.client_id }),
                      ...(event.session_id ? { session_id: event.session_id } : {}),
                    },
                  }}
                >
                  Open traces
                  <ArrowUpRight data-icon="inline-end" />
                </Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-xs text-muted-foreground">
        <span>Reference</span>
        <code className="max-w-80 min-w-0 truncate" title={event.id}>
          {event.id}
        </code>
        <CopyButton content={event.id} label="Copy event reference" />
        <span className="sm:ml-auto">Retained for 30 days</span>
      </div>
    </div>
  )
}
