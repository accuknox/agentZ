"use client"

import { ClaudeAI, CodexLight } from "@ridemountainpig/svgl-react"
import { AppWindowIcon, BotIcon } from "lucide-react"
import { UserAvatar } from "@/components/ui/avatar"
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"
import type { LensApp } from "@/lib/gateway/client"

type SourceIconKind = "agent" | "app" | NonNullable<LensApp["agent_kind"]>

export function LensSourceIcon({
  kind,
  className = "size-4 shrink-0",
}: {
  kind: SourceIconKind
  className?: string
}) {
  switch (kind) {
    case "agent":
      return <BotIcon aria-hidden="true" className={className} />
    case "claude":
      return <ClaudeAI aria-hidden="true" className={className} />
    case "codex":
      return <CodexLight aria-hidden="true" fill="currentColor" className={className} />
    case "app":
      return <AppWindowIcon aria-hidden="true" className={className} />
  }
}

export function ExternalAgentOptions({
  apps,
  valuePrefix,
}: {
  apps: LensApp[]
  valuePrefix: "app:" | "external-agent:"
}) {
  const agents = apps
    .flatMap((app) => (app.agent_kind ? [{ ...app, agent_kind: app.agent_kind }] : []))
    .toSorted(
      (a, b) =>
        (a.user?.name || a.user?.email || "Unknown user").localeCompare(
          b.user?.name || b.user?.email || "Unknown user"
        ) ||
        a.name.localeCompare(b.name) ||
        a.client_id.localeCompare(b.client_id)
    )
  const groups = new Map<string, typeof agents>()
  for (const app of agents) {
    const userID = app.user?.id ?? ""
    const group = groups.get(userID)
    if (group) {
      group.push(app)
      continue
    }
    groups.set(userID, [app])
  }
  if (groups.size === 0) return null
  return (
    <SelectGroup>
      <SelectLabel>External agents</SelectLabel>
      {[...groups].map(([userID, group]) => (
        <SelectGroup key={userID} className="py-0">
          <SelectLabel className="flex items-center gap-2 py-2">
            <UserAvatar {...group[0]?.user} className="ring-1 ring-muted-foreground/20" />
            <span className="truncate">
              {group[0]?.user?.name || group[0]?.user?.email || "Unknown user"}
            </span>
          </SelectLabel>
          {group.map((app) => (
            <SelectItem
              key={app.client_id}
              value={`${valuePrefix}${app.client_id}`}
              className="pl-4"
            >
              <LensSourceIcon kind={app.agent_kind} />
              {app.name}
              {group.some(
                (other) => other.client_id !== app.client_id && other.name === app.name
              ) ? (
                <span
                  className="max-w-28 truncate text-xs text-muted-foreground"
                  title={app.client_id}
                >
                  {app.client_id.slice(-8)}
                </span>
              ) : null}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </SelectGroup>
  )
}

export function ExternalAppOptions({
  apps,
  valuePrefix = "",
  label,
}: {
  apps: LensApp[]
  valuePrefix?: "" | "app:"
  label?: string
}) {
  const ordinaryApps = apps.filter((app) => !app.agent_kind)
  if (ordinaryApps.length === 0) return null
  return (
    <SelectGroup>
      {label ? <SelectLabel>{label}</SelectLabel> : null}
      {ordinaryApps.map((app) => (
        <SelectItem key={app.client_id} value={`${valuePrefix}${app.client_id}`}>
          <LensSourceIcon kind="app" />
          {app.name}
          {ordinaryApps.some(
            (other) => other.name === app.name && other.client_id !== app.client_id
          ) ? (
            <span className="max-w-28 truncate text-xs text-muted-foreground" title={app.client_id}>
              {app.client_id.slice(-8)}
            </span>
          ) : null}
        </SelectItem>
      ))}
    </SelectGroup>
  )
}
