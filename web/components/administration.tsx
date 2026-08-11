import Link from "next/link"
import type { ComponentProps, ReactNode } from "react"
import { CircleAlert, Clock3, FolderSearch, LoaderCircle, LockKeyhole, Trash2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
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
    <div className="@container flex min-w-0 flex-1 flex-col" data-administration>
      <div className="administration-surface flex w-full max-w-7xl min-w-0 flex-1 flex-col self-center px-4 py-6 md:px-8 md:py-10">
        {children}
      </div>
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
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ScopeBadge({ scope }: { scope: AdministrationScope["kind"] }) {
  return <Badge variant="plain">{scope}</Badge>
}

export function StatusBadge({ status }: { status: AdministrationStatus }) {
  if (status === "ready") {
    return (
      <Badge variant="successPlain">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
        Ready
      </Badge>
    )
  }

  if (status === "provisioning") {
    return (
      <Badge variant="plain">
        <LoaderCircle
          aria-hidden="true"
          className="motion-safe:animate-spin"
          data-icon="inline-start"
        />
        Provisioning
      </Badge>
    )
  }

  if (status === "deleting") {
    return (
      <Badge variant="warningPlain">
        <Trash2 aria-hidden="true" data-icon="inline-start" />
        Deleting
      </Badge>
    )
  }

  return (
    <Badge variant="destructivePlain">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      Failed
    </Badge>
  )
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
  return <Badge variant="plain">{source}</Badge>
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
        description: "Infrastructure is being prepared. This page updates when the scope is ready.",
        icon: <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />,
        title: "Provisioning in progress",
      }
      break
    case "deleting":
      content = {
        description:
          "Cleanup is still running. Access remains unavailable until deletion completes.",
        icon: <Trash2 aria-hidden="true" />,
        title: "Deletion in progress",
      }
      break
    case "failed":
      content = {
        description:
          "The operation failed. Review the error and retry when the underlying issue is resolved.",
        icon: <CircleAlert aria-hidden="true" />,
        title: "Something went wrong",
      }
      break
    case "forbidden":
      content = {
        description:
          "Your current access does not include this page. Choose another available scope.",
        icon: <LockKeyhole aria-hidden="true" />,
        title: "Access unavailable",
      }
      break
    case "not-found":
      content = {
        description:
          "This page or scope no longer exists. Check the address or choose another scope.",
        icon: <FolderSearch aria-hidden="true" />,
        title: "Page not found",
      }
      break
    default:
      content = {
        description: "Create the first item or adjust the current filters to continue.",
        icon: <FolderSearch aria-hidden="true" />,
        title: "Nothing here yet",
      }
  }

  const pending = kind === "provisioning" || kind === "deleting"
  const urgent = kind === "failed" || kind === "forbidden"

  return (
    <Empty
      aria-live={pending ? "polite" : urgent ? "assertive" : undefined}
      className="min-h-64 rounded-none border-x-0 border-y border-solid"
      role={pending ? "status" : urgent ? "alert" : undefined}
    >
      <EmptyHeader>
        <EmptyMedia>{content.icon}</EmptyMedia>
        <EmptyTitle>
          <h2>{title ?? content.title}</h2>
        </EmptyTitle>
        <EmptyDescription>{description ?? content.description}</EmptyDescription>
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
      <div className="flex flex-col gap-3 px-4 py-6 md:px-8 md:py-10">
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription className="sr-only">{caption}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <Table className="min-w-2xl">
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="bg-muted/95 sticky left-0 z-10 min-w-48">Resource</TableHead>
              {columns.map((column) => (
                <TableHead className="text-center" key={column.id} scope="col">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableHead className="bg-background sticky left-0 z-10" scope="row">
                  {row.label}
                </TableHead>
                {columns.map((column) => (
                  <TableCell className="text-center" key={column.id}>
                    {row.values[column.id]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function EffectiveAccessFrame({
  canvas,
  inspector,
  summary,
  table,
}: {
  canvas: ReactNode
  inspector?: ReactNode
  summary: string
  table: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Effective Access</h2>
          </CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent
          className={`grid min-h-96 min-w-0 gap-4 ${
            inspector ? "xl:grid-cols-[minmax(0,1fr)_20rem]" : ""
          }`}
        >
          <div className="bg-muted/20 min-h-80 min-w-0 overflow-hidden rounded-lg border">
            {canvas}
          </div>
          {inspector ? (
            <aside aria-label="Access details" className="min-w-0 rounded-lg border p-4">
              {inspector}
            </aside>
          ) : null}
        </CardContent>
      </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <span className="text-muted-foreground text-sm tabular-nums">
            {items.length} affected
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
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
                  {groupItems.map((item, index) => (
                    <li key={item.id}>
                      {index ? <Separator className="mb-3" /> : null}
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
                          <Badge
                            variant={
                              item.severity === "critical"
                                ? "destructivePlain"
                                : item.severity === "warning"
                                  ? "warningPlain"
                                  : "plain"
                            }
                          >
                            {item.severity}
                          </Badge>
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
      </CardContent>
      {actions ? <CardFooter className="justify-end gap-2">{actions}</CardFooter> : null}
    </Card>
  )
}
