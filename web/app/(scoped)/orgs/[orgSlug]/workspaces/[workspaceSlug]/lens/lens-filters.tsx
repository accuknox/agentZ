"use client"

import * as React from "react"
import { useSelectResource } from "@/components/page-selection"
import { MessageSquareIcon } from "lucide-react"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"
import { DateRangePicker } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listAppSessionsAction } from "@/data/lens.actions"
import type { TraceSessionFilterItem } from "@/data/types"
import { dayjs, formatDateParam } from "@/lib/format"
import { selectionURL } from "@/lib/page-selection"
import type { Agent, LensApp } from "@/lib/gateway/client"
import {
  ExternalAgentOptions,
  ExternalAppOptions,
  LensSourceIcon,
} from "@/components/lens-source-options"

type LensFiltersProps = {
  agents: Agent[]
  apps?: LensApp[]
  selectedAppClientID?: string
  defaultAppClientID?: string
  from: string
  selectedAgentName?: string
  selectedSessionId?: string
  sessions?: TraceSessionFilterItem[]
  sessionNextPageToken?: string
  workspaceId: string
  to: string
}

export function LensFilters({
  agents,
  apps: appOptions,
  selectedAppClientID,
  defaultAppClientID,
  from,
  selectedAgentName,
  selectedSessionId,
  sessions,
  sessionNextPageToken,
  workspaceId,
  to,
}: LensFiltersProps) {
  const { select, pending: selectionPending } = useSelectResource(true)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const apps = appOptions ?? []
  const ordinaryApps = apps.filter((app) => !app.agent_kind)
  const selectedApp = apps.find((app) => app.client_id === selectedAppClientID)
  let selectedSubject = ordinaryApps.length > 0 ? "external-apps" : ""
  if (selectedAgentName) selectedSubject = `agent:${selectedAgentName}`
  if (selectedApp?.agent_kind) selectedSubject = `external-agent:${selectedApp.client_id}`
  const disabled = pending || selectionPending

  function updateDate(values: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    const href = selectionURL(
      pathname,
      params,
      {
        agent_name: selectedAgentName,
        app_client_id: selectedAppClientID,
        session_id: selectedSessionId,
      },
      true
    )
    startTransition(() => {
      router.replace(href)
    })
  }

  return (
    <div
      data-pending={disabled}
      className="flex min-h-14 flex-col gap-3 border-b bg-background px-4 py-2 data-[pending=true]:opacity-70 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
        <Select
          value={selectedSubject}
          onValueChange={(value) => {
            if (value === "external-apps") {
              const app =
                ordinaryApps.find((app) => app.client_id === defaultAppClientID) ?? ordinaryApps[0]
              if (app) select({ app_client_id: app.client_id })
              return
            }
            const agent = agents.find((agent) => `agent:${agent.name}` === value)
            if (agent) {
              select({ agent_name: agent.name })
              return
            }
            const external = apps.find(
              (app) => app.agent_kind && `external-agent:${app.client_id}` === value
            )
            if (external) select({ app_client_id: external.client_id })
          }}
          disabled={agents.length + apps.length === 0 || disabled}
        >
          <SelectTrigger
            aria-label="Agent or external apps"
            className="h-8 w-full min-w-0 rounded-md sm:w-64"
          >
            <SelectValue placeholder="Agent or external apps" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              {ordinaryApps.length > 0 ? (
                <SelectItem value="external-apps">
                  <LensSourceIcon kind="app" />
                  External apps
                </SelectItem>
              ) : null}
              {agents.map((agent) => (
                <SelectItem key={agent.name} value={`agent:${agent.name}`}>
                  <LensSourceIcon kind="agent" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
            <ExternalAgentOptions apps={apps} valuePrefix="external-agent:" />
          </SelectContent>
        </Select>
        {selectedSubject === "external-apps" ? (
          <Select
            value={selectedAppClientID ?? ""}
            onValueChange={(app_client_id) => select({ app_client_id })}
            disabled={ordinaryApps.length === 0 || disabled}
          >
            <SelectTrigger
              aria-label="External app"
              className="h-8 w-full min-w-0 rounded-md sm:w-72"
            >
              <SelectValue placeholder="External app" className="truncate" />
            </SelectTrigger>
            <SelectContent position="popper">
              <ExternalAppOptions apps={ordinaryApps} />
            </SelectContent>
          </Select>
        ) : sessions ? (
          <LensSessionPicker
            key={JSON.stringify([
              workspaceId,
              selectedSubject,
              selectedSessionId,
              sessions,
              sessionNextPageToken,
            ])}
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            disabled={disabled}
            nextPageToken={sessionNextPageToken}
            clientID={selectedApp?.agent_kind ? selectedApp.client_id : undefined}
            workspaceId={workspaceId}
            onSelect={(session_id) =>
              select({
                agent_name: selectedAgentName,
                app_client_id: selectedAppClientID,
                session_id,
              })
            }
          />
        ) : null}
        <DateRangePicker
          className="w-full sm:w-auto"
          onSelect={(range) =>
            updateDate({ from: formatDateParam(range.from), to: formatDateParam(range.to) })
          }
          range={{ from: dayjs(from).toDate(), to: dayjs(to).toDate() }}
        />
      </div>
    </div>
  )
}

function LensSessionPicker({
  sessions,
  selectedSessionId,
  disabled,
  nextPageToken,
  clientID,
  workspaceId,
  onSelect,
}: {
  sessions: TraceSessionFilterItem[]
  selectedSessionId?: string
  disabled: boolean
  nextPageToken?: string
  clientID?: string
  workspaceId: string
  onSelect: (sessionId: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState(sessions)
  const [next, setNext] = React.useState(nextPageToken)
  const [loading, startTransition] = React.useTransition()
  const [error, setError] = React.useState<string>()
  const observeMore = React.useCallback(
    (target: HTMLDivElement | null) => {
      if (!open || !next || !clientID || loading || error || !target) return
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        startTransition(async () => {
          const result = await listAppSessionsAction(clientID, workspaceId, {
            limit: 50,
            page_token: next,
          })
          if (result.error) {
            setError(result.error.message)
            return
          }
          setItems((current) => [
            ...current,
            ...result.data.sessions
              .filter((session) => !current.some((item) => item.sessionId === session.session_id))
              .map((session) => ({ sessionId: session.session_id, title: session.session_id })),
          ])
          setNext(result.data.next_page_token)
        })
      })
      observer.observe(target)
      return () => observer.disconnect()
    },
    [open, next, clientID, workspaceId, loading, error]
  )

  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-72">
      <Select
        open={open}
        onOpenChange={setOpen}
        value={items.length ? (selectedSessionId ?? "") : ""}
        onValueChange={onSelect}
        disabled={disabled || items.length === 0}
      >
        <SelectTrigger
          aria-label="Session"
          aria-invalid={!!error}
          className="h-8 w-full min-w-0 rounded-md"
        >
          <SelectValue
            placeholder={
              <>
                <MessageSquareIcon aria-hidden="true" />
                Session
              </>
            }
            className="min-w-0 truncate"
          />
        </SelectTrigger>
        <SelectContent position="popper" aria-busy={loading}>
          <SelectGroup>
            {items.map((session, index) => (
              <SelectItem
                key={session.sessionId}
                value={session.sessionId}
                ref={index === items.length - 1 ? observeMore : undefined}
              >
                <MessageSquareIcon aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate" title={session.sessionId}>
                  {session.title}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
          {loading ? (
            <div role="status" className="px-2 py-1 text-xs text-muted-foreground">
              Loading sessions…
            </div>
          ) : null}
        </SelectContent>
      </Select>
      {error ? (
        <FieldError>
          {error}
          <Button variant="link" size="sm" onClick={() => setError(undefined)}>
            Retry
          </Button>
        </FieldError>
      ) : null}
    </div>
  )
}
