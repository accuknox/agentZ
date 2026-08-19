import Link from "next/link"
import Image from "next/image"
import type { ComponentProps, ReactNode } from "react"
import { Clock3, FolderSearch, LoaderCircle, Trash2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarTrigger } from "@/components/ui/sidebar"
export type AdministrationPageScope =
  | { kind: "organization"; organizationName: string }
  | { kind: "workspace"; organizationName: string; workspaceName: string }

type AdministrationStatus = "ready" | "provisioning" | "deleting" | "failed"

export function AdministrationLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="@container flex min-w-0 flex-1 flex-col [&_[data-slot=table-head]]:h-8 [&_[data-slot=table-head]]:px-4 [&_[data-slot=table-head]]:align-middle [&_[data-slot=table]]:w-full"
      data-administration
    >
      {children}
    </div>
  )
}

export function AdministrationPageHeader({
  actions,
  description,
  scope,
  title,
}: {
  actions?: ReactNode
  description?: ReactNode
  scope?: AdministrationPageScope
  title: string
}) {
  return (
    <div className="flex gap-1 px-1.5 pt-4 md:px-2.5 md:pt-6">
      <SidebarTrigger className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-normal" title={title}>
            {title}
          </h1>
          {description ? <p className="text-muted-foreground mt-1 text-sm">{description}</p> : null}
          {scope ? (
            <Badge className="mt-1.5 max-w-full font-normal" variant="secondary">
              <span className="shrink-0">
                {scope.kind === "organization" ? "Organization" : "Workspace"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {scope.kind === "organization" ? scope.organizationName : scope.workspaceName}
              </span>
            </Badge>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

export function ScopeBadge({ scope }: { scope: "Organisation" | "Workspace" }) {
  return (
    <span className="text-muted-foreground">
      {scope === "Organisation" ? "Organization" : scope}
    </span>
  )
}

export function StatusBadge({ status }: { status: AdministrationStatus }) {
  if (status === "ready") {
    return <Badge variant="success">Ready</Badge>
  }

  if (status === "provisioning") {
    return (
      <Badge variant="pending">
        <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
        Provisioning
      </Badge>
    )
  }

  if (status === "deleting") {
    return (
      <Badge variant="warning">
        <Trash2 aria-hidden="true" />
        Deleting
      </Badge>
    )
  }

  return <Badge variant="destructive">Failed</Badge>
}

type AccessSource = "Direct Role" | "Team Role" | "Ownership" | "Direct Share" | "Team Share"

export function AccessSourceChip({ source }: { source: AccessSource }) {
  return <span className="text-muted-foreground">{source}</span>
}

type AdministrationStateKind =
  | "empty"
  | "welcome"
  | "provisioning"
  | "deleting"
  | "failed"
  | "forbidden"
  | "not-found"

export function AdministrationState({
  actions,
  description,
  kind,
  title,
}: {
  actions?: ReactNode
  description?: string
  kind: AdministrationStateKind
  title?: string
}) {
  let content: { description: string; icon: ReactNode; title: string }

  switch (kind) {
    case "provisioning":
      content = {
        description: "We're creating this resource.",
        icon: <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />,
        title: "Provisioning in progress",
      }
      break
    case "deleting":
      content = {
        description: "We're deleting this resource.",
        icon: <Trash2 aria-hidden="true" />,
        title: "Deletion in progress",
      }
      break
    case "failed":
      content = {
        description: "An unexpected problem prevented this page from loading.",
        icon: <Image alt="" height={112} src="/cry-emoji.svg" width={112} loading="eager" />,
        title: "Page could not load",
      }
      break
    case "forbidden":
      content = {
        description: "Your account does not have permission to do this.",
        icon: <Image alt="" height={112} src="/cry-emoji.svg" width={112} loading="eager" />,
        title: "",
      }
      break
    case "not-found":
      content = {
        description: "This page does not exist.",
        icon: <Image alt="" height={112} src="/file-corrupted.svg" width={112} loading="eager" />,
        title: "Page not found",
      }
      break
    default:
      content = {
        description: "No results.",
        icon: <FolderSearch aria-hidden="true" />,
        title: "Nothing here yet",
      }
  }

  const pending = kind === "provisioning" || kind === "deleting"
  const urgent = kind === "failed" || kind === "forbidden"
  const illustrated = kind === "failed" || kind === "forbidden" || kind === "not-found"
  const welcoming = kind === "welcome"
  const stateDescription = description ?? content.description
  const stateTitle = title ?? content.title

  return (
    <Empty
      aria-live={pending ? "polite" : urgent ? "assertive" : undefined}
      className={
        illustrated
          ? "min-h-80 gap-5 rounded-none border-0 py-10"
          : welcoming
            ? "border-primary mx-3 min-h-80 w-auto flex-none border border-dashed py-12 sm:min-h-96 md:mx-6"
            : "min-h-48 rounded-none border-0"
      }
      role={pending ? "status" : urgent ? "alert" : undefined}
    >
      <EmptyHeader className={illustrated || welcoming ? "max-w-md gap-3" : undefined}>
        <EmptyMedia className={illustrated ? "mb-1" : welcoming ? "mb-0" : undefined}>
          {welcoming ? (
            <span aria-hidden="true" className="text-4xl leading-none">
              👋
            </span>
          ) : (
            content.icon
          )}
        </EmptyMedia>
        {stateTitle ? (
          <EmptyTitle
            className={illustrated ? "text-base font-semibold" : welcoming ? "text-xl" : undefined}
          >
            <h2>{stateTitle}</h2>
          </EmptyTitle>
        ) : null}
        {stateDescription !== "" ? <EmptyDescription>{stateDescription}</EmptyDescription> : null}
      </EmptyHeader>
      {actions ? <EmptyContent>{actions}</EmptyContent> : null}
    </Empty>
  )
}

export function AdministrationLoadingState() {
  return (
    <div
      aria-label="Loading administration page"
      className="flex min-w-0 flex-1 flex-col"
      role="status"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-3 px-4 py-6 md:px-6">
        <Skeleton className="mb-3 h-7 w-48 max-w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  )
}

export function EffectiveAccessFrame({
  canvas,
  summary,
  table,
}: {
  canvas: ReactNode
  summary?: string
  table: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="min-w-0 space-y-3">
        <div className="px-4 md:px-6">
          <h2 className="text-lg font-medium">Effective access</h2>
          {summary ? <p className="text-muted-foreground text-sm">{summary}</p> : null}
        </div>
        <div className="grid min-h-96 min-w-0">
          <div className="bg-muted/20 min-h-80 min-w-0 overflow-hidden">{canvas}</div>
        </div>
      </section>
      {table}
    </div>
  )
}

type ImpactReviewItem = {
  id: string
  label: string
  detail?: string
  group?: string
  href?: ComponentProps<typeof Link>["href"]
  severity?: "critical" | "warning" | "info"
}

export function ImpactReviewFrame({
  actions,
  description,
  items,
  title,
}: {
  actions?: ReactNode
  description: string
  items: readonly ImpactReviewItem[]
  title: string
}) {
  const groups = new Map<string, readonly ImpactReviewItem[]>()
  for (const item of items) {
    const group = item.group ?? "Impact"
    groups.set(group, [...(groups.get(group) ?? []), item])
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4 px-4 md:px-6">
        <div>
          <h2 className="text-lg font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
          {items.length} affected
        </span>
      </div>
      <div className="px-4 md:px-6">
        {items.length ? (
          <div className="grid gap-5">
            {[...groups].map(([group, groupItems]) => (
              <section aria-labelledby={`impact-${group}`} className="grid gap-2" key={group}>
                <h3 className="text-muted-foreground text-xs font-medium" id={`impact-${group}`}>
                  {group}
                </h3>
                <ul className="flex flex-col gap-3">
                  {groupItems.map((item) => (
                    <li key={item.id}>
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          {item.href ? (
                            <Link
                              className="font-medium break-words underline-offset-4 hover:underline"
                              href={item.href}
                            >
                              {item.label}
                            </Link>
                          ) : (
                            <span className="font-medium break-words">{item.label}</span>
                          )}
                          {item.detail ? (
                            <span className="text-muted-foreground text-sm break-words">
                              {item.detail}
                            </span>
                          ) : null}
                        </div>
                        {item.severity ? (
                          <span
                            className={
                              item.severity === "critical"
                                ? "text-destructive text-sm"
                                : item.severity === "warning"
                                  ? "text-warning text-sm"
                                  : "text-muted-foreground text-sm"
                            }
                          >
                            {item.severity}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <Alert>
            <Clock3 aria-hidden="true" />
            <AlertTitle>No dependent changes</AlertTitle>
            <AlertDescription>
              This action does not change any dependent resources.
            </AlertDescription>
          </Alert>
        )}
      </div>
      {actions ? <div className="flex justify-end gap-2 px-4 md:px-6">{actions}</div> : null}
    </section>
  )
}
