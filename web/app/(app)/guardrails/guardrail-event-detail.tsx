"use client"

import Link from "next/link"
import { useParams, useSearchParams } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Box,
  Bot,
  ChevronRight,
  Layers3,
  Regex,
  MessagesSquare,
  MessageSquareText,
  ScrollText,
  Wrench,
  Clock3,
} from "lucide-react"
import type { GuardrailConnection, GuardrailEvent } from "@/lib/gateway/client"
import { getGuardrailEventContextAction } from "@/data/guardrail-event.actions"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTimestamp } from "@/lib/format"
import { contentScopes, detectors, verdicts } from "./event-shared"
import { GuardrailProviderIcon } from "./provider-shared"

const providers: Partial<
  Record<GuardrailEvent["evaluation"]["guard"], GuardrailConnection["provider"]>
> = {
  openAIModeration: "OpenAI",
  bedrockGuardrails: "Bedrock",
  googleModelArmor: "ModelArmor",
  webhook: "Webhook",
}

export function GuardrailEventSkeleton() {
  return (
    <div role="status" aria-label="Loading evaluation" className="min-h-0 flex-1 overflow-y-auto">
      <section className="flex flex-col gap-5 px-5 py-6 sm:px-7 sm:py-7">
        <div className="flex h-5 items-center justify-between gap-3">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[1.875rem] w-64 max-w-full" />
          <Skeleton className="h-5 w-44" />
        </div>
        <Skeleton className="h-5 w-72 max-w-full" />
      </section>
      <Separator />
      <section className="grid gap-6 px-5 py-5 sm:grid-cols-2 sm:px-7 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-4 w-16" />
            <div className="flex h-5 items-center gap-2">
              <Skeleton className="size-4" />
              <Skeleton className="h-4 w-24" />
            </div>
            {index === 0 ? <Skeleton className="h-4 w-28" /> : null}
          </div>
        ))}
      </section>
      <Separator />
      <section className="flex flex-col gap-5 px-5 py-6 sm:px-7">
        <div className="flex h-5 items-center justify-between gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[calc(6lh+2rem)] max-h-64 text-xs leading-relaxed" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-4 w-44" />
      </section>
    </div>
  )
}

export function GuardrailEventDetail({
  event,
  basePath,
  workspaceId,
}: {
  event: GuardrailEvent
  basePath: `/orgs/${string}/guardrails`
  workspaceId?: string
}) {
  const { orgSlug } = useParams<{ orgSlug: string }>()
  const searchParams = useSearchParams()
  const { evaluation } = event
  const { context } = evaluation
  const verdict = verdicts[evaluation.action]
  const failed = context?.reason === "checker_error"
  const scope =
    context?.matchedScope ?? (context?.scopes.length === 1 ? context.scopes[0] : undefined)
  const ContentIcon =
    scope === "instructions"
      ? ScrollText
      : scope === "toolArguments" || scope === "toolResults"
        ? Wrench
        : evaluation.phase === "response"
          ? MessageSquareText
          : MessagesSquare
  const content = scope
    ? scope === "conversation"
      ? evaluation.phase === "request"
        ? "Chat messages"
        : "Assistant response"
      : contentScopes[scope]
    : evaluation.phase === "request"
      ? "Model request"
      : "Model response"
  const policy = context?.policyName || context?.policyId
  const provider = providers[evaluation.guard]
  const investigation = useQuery(
    queryOptions({
      queryKey: ["guardrail-event-context", workspaceId, event.id],
      queryFn: async () => {
        const result = await getGuardrailEventContextAction(event.id, workspaceId)
        if (result.error) throw new Error(result.error.message)
        return result.data
      },
      staleTime: 0,
      retry: false,
    })
  )
  const captured = investigation.data
  const messageSection = evaluation.phase === "response" ? "output_messages" : "input_messages"
  const scopeSection =
    scope === "toolArguments"
      ? "tool_arguments"
      : scope === "toolResults"
        ? "tool_result"
        : messageSection
  const section = captured?.span?.payload.some((item) => item.key === scopeSection && !item.empty)
    ? scopeSection
    : messageSection
  const payload = captured?.span?.payload.find((item) => item.key === section && !item.empty)
  const workspacePath = captured?.workspaceSlug
    ? `/orgs/${orgSlug}/workspaces/${captured.workspaceSlug}`
    : undefined
  const traceQuery = new URLSearchParams({
    trace_id: captured?.source?.trace_id ?? "",
    span_id: captured?.source?.span_id ?? "",
    operation_id: String(captured?.source?.operation_id ?? ""),
    section,
  })
  if (captured?.source?.agent_name) traceQuery.set("agent_name", captured.source.agent_name)
  else if (captured?.source?.client_id) traceQuery.set("app_client_id", captured.source.client_id)
  if (captured?.source?.session_id) traceQuery.set("session_id", captured.source.session_id)
  const related = new URLSearchParams({ trace_id: event.trace_id })
  for (const name of ["from", "to"]) {
    const value = searchParams.get(name)
    if (value) related.set(name, value)
  }
  const agentName =
    captured?.source?.agent_name || event.trace_source?.agent_name || event.agent_name
  const source = agentName || event.subject_name || event.client_id
  const sourceHref =
    agentName && workspacePath
      ? `${workspacePath}/agents/${encodeURIComponent(agentName)}`
      : undefined
  const sandboxHref = `${basePath.slice(0, -"/guardrails".length)}/sandboxes/update/${encodeURIComponent(event.sandbox_name)}`
  const policyHref = context?.policyId
    ? `${basePath}/policies/${encodeURIComponent(context.policyId)}`
    : undefined
  let heading = "Policy finding recorded"
  let consequence = "Finding logged; processing continued."
  if (evaluation.action === "reject") {
    heading = `${content} blocked`
    consequence =
      evaluation.phase === "request"
        ? "Request rejected before model execution."
        : "Response withheld from the client."
  }
  if (evaluation.action === "mask") {
    heading = `${content} masked`
    consequence = "Matched content redacted; processing continued."
  }
  if (failed || evaluation.action === "failOpen") {
    heading = evaluation.action === "reject" ? "Guardrail failed closed" : "Guardrail failed open"
    consequence =
      evaluation.action === "reject"
        ? "Checker error; request rejected."
        : "Checker error; processing continued."
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <section className="flex flex-col gap-5 px-5 py-6 sm:px-7 sm:py-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge variant={failed ? "warning" : verdict.variant}>
            <verdict.icon data-icon="inline-start" />
            {failed && evaluation.action === "reject" ? "Fail closed" : verdict.label}
          </Badge>
          <time
            dateTime={event.occurred_at}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Clock3 aria-hidden className="size-3.5" />
            {formatTimestamp(event.occurred_at)}
          </time>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl leading-tight font-semibold tracking-tight">{heading}</h2>
          {policy ? (
            <p className="text-sm text-muted-foreground">
              By policy named &quot;
              {policyHref ? (
                <Link
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  href={{ pathname: policyHref }}
                >
                  {policy}
                </Link>
              ) : (
                policy
              )}
              &quot;
            </p>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">{consequence}</p>
        {context?.message && !failed ? (
          <Alert>
            <AlertDescription>{context.message}</AlertDescription>
          </Alert>
        ) : null}
      </section>
      <Separator />
      <section className="grid gap-6 px-5 py-5 sm:grid-cols-2 sm:px-7 lg:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs text-muted-foreground">Check</h3>
          <div className="flex items-center gap-2">
            {provider ? (
              <GuardrailProviderIcon provider={provider} />
            ) : evaluation.guard === "regex" ? (
              <Regex aria-hidden className="size-4 text-muted-foreground" />
            ) : null}
            {policyHref ? (
              <Link
                className="min-w-0 truncate font-medium underline-offset-4 hover:text-primary hover:underline"
                href={{
                  pathname: policyHref,
                  query: { check: context?.checkId },
                }}
              >
                {context?.checkName || detectors[evaluation.guard] || "Guardrail check"}
              </Link>
            ) : (
              <span className="font-medium">
                {context?.checkName || detectors[evaluation.guard] || "Guardrail check"}
              </span>
            )}
            <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground">
            {detectors[evaluation.guard] || evaluation.guard}
          </p>
        </div>
        {workspacePath || investigation.isPending ? (
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs text-muted-foreground">Workspace</h3>
            <div className="flex h-5 min-w-0 items-center gap-2">
              <Layers3 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {workspacePath ? (
                <Link
                  className="truncate font-medium underline-offset-4 hover:text-primary hover:underline"
                  href={{ pathname: workspacePath }}
                >
                  {captured?.workspaceName}
                </Link>
              ) : (
                <Skeleton className="h-4 w-24" />
              )}
            </div>
          </div>
        ) : null}
        {source || investigation.isPending ? (
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs text-muted-foreground">
              {investigation.isPending ? "Source" : agentName ? "Agent" : "Application"}
            </h3>
            <div className="flex h-5 items-center gap-2">
              {investigation.isPending ? (
                <Skeleton className="size-4 shrink-0" />
              ) : agentName ? (
                <Bot aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : null}
              {investigation.isPending ? (
                <Skeleton className="h-4 w-24" />
              ) : sourceHref ? (
                <Link
                  className="truncate font-medium underline-offset-4 hover:text-primary hover:underline"
                  href={{ pathname: sourceHref }}
                >
                  {source}
                </Link>
              ) : (
                <span className="truncate font-medium">{source}</span>
              )}
            </div>
            {event.model ? <p className="text-xs text-muted-foreground">{event.model}</p> : null}
          </div>
        ) : null}
        {event.sandbox_name ? (
          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs text-muted-foreground">Sandbox</h3>
            <div className="flex h-5 min-w-0 items-center gap-2">
              <Box aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Link
                className="truncate font-medium underline-offset-4 hover:text-primary hover:underline"
                href={{ pathname: sandboxHref }}
              >
                {event.sandbox_name}
              </Link>
            </div>
          </div>
        ) : null}
      </section>
      <Separator />
      <section className="flex flex-col gap-5 px-5 py-6 sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-medium">
            <ContentIcon aria-hidden className="size-4 text-muted-foreground" />
            {content}
          </h3>
          {captured?.source && workspacePath ? (
            <Link
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
              href={{
                pathname: `${workspacePath}/lens/traces`,
                query: Object.fromEntries(traceQuery),
              }}
            >
              Open in Lens
              <ArrowUpRight aria-hidden className="size-3.5" />
            </Link>
          ) : investigation.isPending ? (
            <Skeleton className="h-5 w-24" />
          ) : null}
        </div>
        {investigation.isPending ? (
          <div role="status" aria-label="Loading trace context" className="flex flex-col gap-3">
            <div className="rounded-md bg-muted/30 p-4 text-xs leading-relaxed">
              {["w-4", "ml-3 w-4", "ml-6 w-1/2", "ml-6 w-3/4", "ml-3 w-4", "w-4"].map(
                (width, index) => (
                  <div key={index} className="flex h-lh items-center">
                    <div className={width}>
                      <Skeleton className="h-3" />
                    </div>
                  </div>
                )
              )}
            </div>
            <Skeleton className="h-4 w-32" />
          </div>
        ) : payload ? (
          <div className="flex flex-col gap-3">
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/30 p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {"text" in payload.content ? payload.content.text : payload.content.code}
            </pre>
            <p className="text-xs text-muted-foreground">
              {captured?.span?.span.displayName}
              {captured?.span?.span.duration ? ` · ${captured.span.span.duration}` : ""}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/30 px-4 py-5">
            <p className="text-sm font-medium">
              {captured?.source
                ? captured.contentError
                  ? "Content unavailable"
                  : "Content was not captured"
                : "Trace unavailable"}
            </p>
            <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
              {investigation.error?.message ||
                captured?.contentError ||
                "No payload was recorded for this span."}
            </p>
          </div>
        )}
        {context && context.scopes.length > 1 ? (
          <p className="text-xs text-muted-foreground">
            Also inspected:{" "}
            {context.scopes
              .filter((item) => item !== scope)
              .map((item) => contentScopes[item])
              .join(", ")}
          </p>
        ) : null}
        {event.trace_id ? (
          <Link
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
            href={`${basePath}/events?${related}`}
          >
            Other evaluations in this trace
            <ArrowUpRight aria-hidden className="size-3" />
          </Link>
        ) : null}
      </section>
    </div>
  )
}
