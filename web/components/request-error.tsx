"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Calendar, CircleAlert, CloudOff, RefreshCw, ShieldQuestion } from "lucide-react"
import type { Agent, Error as GatewayError } from "@/lib/gateway/client"
import { defaultAgentAppearance, mascots, mascotColors } from "@/data/mascots"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AgentPresence } from "@/components/interior/agent-presence"
import { StateIllustration } from "@/components/state-illustration"

/** RequestError keeps recoverable failures beside the content they affect. */
export function RequestError({
  title,
  error,
  description,
  onRetry,
  className,
  compact = false,
  agent,
  resetFilters = false,
}: {
  title: string
  error?: GatewayError
  description?: string
  onRetry?: () => void | Promise<void>
  className?: string
  compact?: boolean
  agent?: Pick<Agent, "name" | "appearance" | "status">
  resetFilters?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Alert
      className={cn(
        !compact &&
          "flex min-h-64 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-foreground",
        className
      )}
      variant="destructive"
      role={agent?.status === "PROGRESSING" ? "status" : "alert"}
    >
      {compact ? (
        <CircleAlert aria-hidden="true" />
      ) : (
        <RequestErrorArt code={error?.code} agent={agent} />
      )}
      <AlertTitle className={compact ? undefined : "text-lg font-semibold tracking-tight"}>
        {title}
      </AlertTitle>
      <AlertDescription className={!compact ? "flex max-w-md flex-col items-center" : undefined}>
        {error?.message ? <p>{error.message}</p> : null}
        {error?.errors?.length ? (
          <ul className="list-inside list-disc text-muted-foreground">
            {error.errors.map((issue, index) => (
              <li key={`${issue.field}:${index}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
        {description ? <p className="max-w-sm text-muted-foreground">{description}</p> : null}
      </AlertDescription>
      {resetFilters ? (
        <Button asChild variant="outline">
          <Link href="?">Reset filters</Link>
        </Button>
      ) : (
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (onRetry) return onRetry()
              router.refresh()
            })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw
            data-icon="inline-start"
            aria-hidden="true"
            className={pending ? "motion-safe:animate-spin" : undefined}
          />
          {pending ? "Retrying…" : "Try again"}
        </Button>
      )}
    </Alert>
  )
}

/** AgentUnavailable distinguishes a failed runtime from a missing conversation. */
export function AgentUnavailable({
  agent,
  error,
}: {
  agent: Pick<Agent, "name" | "appearance" | "status">
  error?: GatewayError
}) {
  const starting = agent.status === "PROGRESSING"
  return (
    <RequestError
      agent={agent}
      title={starting ? `${agent.name} is getting ready` : `${agent.name} needs a little help`}
      error={error}
      description={
        starting
          ? "The agent is starting or applying changes. Try again shortly."
          : "This agent cannot respond right now. Contact the platform administrator."
      }
    />
  )
}

function RequestErrorArt({
  code,
  agent,
}: {
  code?: string
  agent?: Pick<Agent, "appearance" | "status">
}) {
  const identity = agent?.appearance ?? defaultAgentAppearance
  const character = mascots[identity.breed]
  const [x, y, x2, y2] = character.eyes
  const denied = code === "forbidden" || code === "unauthorized"
  const Icon =
    code === "invalid_time_range"
      ? Calendar
      : denied
        ? ShieldQuestion
        : code === "invalid_request"
          ? CircleAlert
          : CloudOff

  return (
    <StateIllustration badge={agent ? "?" : "!"}>
      {agent?.status === "PROGRESSING" ? (
        <AgentPresence state="thinking" size={112} mascot={identity.breed} color={identity.color} />
      ) : agent ? (
        <svg
          className="relative h-28 w-28 -rotate-6 [--mascot-ink:var(--mascot-light)] dark:[--mascot-ink:var(--mascot-dark)]"
          viewBox="0 0 124 128"
          style={mascotColors[identity.color].style}
        >
          <path
            d={character.path}
            fill={character.stroke ? "none" : "var(--mascot-ink)"}
            stroke={character.stroke ? "var(--mascot-ink)" : "none"}
            strokeWidth="28"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <g fill="none" stroke="#26242b" strokeWidth="4" strokeLinecap="round">
            <path d={`M${x - 5} ${y + 3}q5 -5 10 0M${x2 - 5} ${y2 + 3}q5 -5 10 0`} />
            <path d={`M${(x + x2) / 2 - 3} ${Math.max(y, y2) + 15}q4 -4 8 0`} />
          </g>
          <rect
            x="24"
            y="36"
            width="24"
            height="10"
            rx="4"
            fill="var(--background)"
            transform="rotate(-25 36 41)"
          />
          <path
            d="M34 40h4m-2 -2v4"
            stroke="var(--warning-foreground)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <div className="relative grid size-20 rotate-6 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border">
          <Icon className="size-10 stroke-[1.5] text-muted-foreground">
            {code === "invalid_time_range" ? (
              <g>
                <circle cx="8" cy="13" r="0.75" fill="currentColor" stroke="none" />
                <circle cx="16" cy="13" r="0.75" fill="currentColor" stroke="none" />
                <path d="M10 18q2 -2 4 0" />
              </g>
            ) : null}
          </Icon>
        </div>
      )}
    </StateIllustration>
  )
}
