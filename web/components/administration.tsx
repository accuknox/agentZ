import type { ReactNode } from "react"
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

export function AdministrationLayout({
  actions,
  children,
  description,
  navigation,
  scope,
  status,
}: {
  actions?: ReactNode
  children: ReactNode
  description?: string
  navigation?: ReactNode
  scope: AdministrationScope
  status?: AdministrationStatus
}) {
  return (
    <div className="@container flex min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex min-w-0 flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ScopeBadge scope={scope.kind} />
              {status ? <StatusBadge status={status} /> : null}
              {scope.kind === "Workspace" ? (
                <span className="text-muted-foreground max-w-full truncate text-sm">
                  {scope.organisationName}
                </span>
              ) : null}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-normal" title={scope.name}>
                {scope.name}
              </h1>
              {description ? (
                <p className="text-muted-foreground mt-1 max-w-3xl text-sm text-pretty">
                  {description}
                </p>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
        {navigation}
      </header>
      <div className="flex min-w-0 flex-1 flex-col px-4 py-6 md:px-6">{children}</div>
    </div>
  )
}

export function ScopeBadge({ scope }: { scope: AdministrationScope["kind"] }) {
  return <Badge variant={scope === "Organisation" ? "secondary" : "outline"}>{scope}</Badge>
}

export function StatusBadge({ status }: { status: AdministrationStatus }) {
  if (status === "ready") {
    return <Badge variant="success">Ready</Badge>
  }

  if (status === "provisioning") {
    return (
      <Badge variant="pending">
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
      <Badge variant="warning">
        <Trash2 aria-hidden="true" data-icon="inline-start" />
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

export function AccessSourceChip({ source }: { source: AccessSource }) {
  return <Badge variant="outline">{source}</Badge>
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
      className="min-h-72 border"
      role={pending ? "status" : urgent ? "alert" : undefined}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">{content.icon}</EmptyMedia>
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
      <div className="flex flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-lg max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 py-6 md:px-6">
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
}: {
  caption: string
  columns: readonly PermissionMatrixColumn[]
  rows: readonly PermissionMatrixRow[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Permissions</h2>
        </CardTitle>
        <CardDescription>{caption}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="bg-muted/95 sticky left-0 min-w-48">Resource</TableHead>
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
                <TableHead className="bg-background sticky left-0" scope="row">
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
        <CardContent className="grid min-h-96 min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
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

export type ImpactReviewItem = { id: string; label: string; detail?: string }

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
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Badge variant="outline">{items.length} affected</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length ? (
          <ul className="flex flex-col gap-3">
            {items.map((item, index) => (
              <li key={item.id}>
                {index ? <Separator className="mb-3" /> : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium break-words">{item.label}</span>
                  {item.detail ? (
                    <span className="text-muted-foreground text-sm break-words">{item.detail}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
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
