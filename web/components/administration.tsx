import Link from "next/link"
import type { ComponentProps, ReactNode } from "react"
import { Clock3, FolderSearch, LoaderCircle, LockKeyhole, Trash2 } from "lucide-react"
import { BotIcon } from "@/components/bot-icon"
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
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type AdministrationScope =
  | { kind: "Organisation"; name: string }
  | { kind: "Workspace"; name: string; organisationName: string }

export type AdministrationStatus = "ready" | "provisioning" | "deleting" | "failed"

export function AdministrationLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="@container flex min-w-0 flex-1 flex-col [&_[data-slot=table-cell]]:h-11 [&_[data-slot=table-cell]]:px-4 [&_[data-slot=table-cell]]:py-1.5 [&_[data-slot=table-cell]]:align-middle [&_[data-slot=table-head]]:h-8 [&_[data-slot=table-head]]:px-4 [&_[data-slot=table-head]]:align-middle [&_[data-slot=table]]:w-full"
      data-administration
    >
      {children}
    </div>
  )
}

export function AdministrationPageHeader({
  actions,
  title,
}: {
  actions?: ReactNode
  title: string
}) {
  return (
    <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ScopeBadge({ scope }: { scope: AdministrationScope["kind"] }) {
  return <span className="text-muted-foreground">{scope}</span>
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

export type AccessSource =
  | "Direct Role"
  | "Team Role"
  | "Superadmin"
  | "Workspace Admin"
  | "Ownership"
  | "Agent Share"
  | "Direct Share"
  | "Team Share"

export function AccessSourceChip({ source }: { source: AccessSource }) {
  return <span className="text-muted-foreground">{source}</span>
}

export type AdministrationStateKind =
  | "empty"
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
        description: "Preparing resources.",
        icon: <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />,
        title: "Provisioning in progress",
      }
      break
    case "deleting":
      content = {
        description: "Cleanup in progress.",
        icon: <Trash2 aria-hidden="true" />,
        title: "Deletion in progress",
      }
      break
    case "failed":
      content = {
        description: "Refresh the page.",
        icon: <BotIcon aria-hidden="true" className="text-primary" size={80} />,
        title: "Something went wrong",
      }
      break
    case "forbidden":
      content = {
        description: "You do not have access to this page.",
        icon: <LockKeyhole aria-hidden="true" />,
        title: "Access unavailable",
      }
      break
    case "not-found":
      content = {
        description: "This page does not exist.",
        icon: <FolderSearch aria-hidden="true" />,
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
  const stateDescription = description ?? content.description

  return (
    <Empty
      aria-live={pending ? "polite" : urgent ? "assertive" : undefined}
      className={
        kind === "failed"
          ? "min-h-80 gap-5 rounded-none border-0 py-10"
          : "min-h-48 rounded-none border-0"
      }
      role={pending ? "status" : urgent ? "alert" : undefined}
    >
      <EmptyHeader className={kind === "failed" ? "gap-3" : undefined}>
        <EmptyMedia className={kind === "failed" ? "mb-1" : undefined}>{content.icon}</EmptyMedia>
        <EmptyTitle className={kind === "failed" ? "text-base font-semibold" : undefined}>
          <h2>{title ?? content.title}</h2>
        </EmptyTitle>
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
      <span className="sr-only">Loading...</span>
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

export type PermissionMatrixColumn = { id: string; label: string }
export type PermissionMatrixRow = {
  id: string
  label: string
  values: Readonly<Record<string, ReactNode>>
}

export function PermissionMatrixFrame({
  caption,
  columns,
  rows,
  title = "Permissions",
}: {
  caption: string
  columns: readonly PermissionMatrixColumn[]
  rows: readonly PermissionMatrixRow[]
  title?: string
}) {
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="px-4 text-lg font-medium md:px-6">{title}</h2>
      <div className="w-full min-w-0 overflow-x-auto border-b">
        <Table className="min-w-2xl">
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="bg-muted/95 sticky left-0 z-10 h-8 min-w-48 px-4">
                Resource
              </TableHead>
              {columns.map((column) => (
                <TableHead className="h-8 px-4 text-center" key={column.id} scope="col">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableHead className="bg-background sticky left-0 z-10 h-11 px-4" scope="row">
                  {row.label}
                </TableHead>
                {columns.map((column) => (
                  <TableCell className="h-11 px-4 py-1.5 text-center" key={column.id}>
                    {row.values[column.id]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
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

export type ImpactReviewItem = {
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
                <h3
                  className="text-muted-foreground text-xs font-medium uppercase"
                  id={`impact-${group}`}
                >
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
            <AlertDescription>The requested action has no additional impact.</AlertDescription>
          </Alert>
        )}
      </div>
      {actions ? <div className="flex justify-end gap-2 px-4 md:px-6">{actions}</div> : null}
    </section>
  )
}
