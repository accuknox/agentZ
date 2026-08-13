"use client"

import Link from "next/link"
import * as React from "react"
import { CheckCircle2, CircleAlert, CircleDashed, ListTree, XCircle } from "lucide-react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  replaceWorkspaceInheritanceAction,
  type WorkspaceInheritanceFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type {
  InheritedResourceType,
  ResourceLifecycle,
  WorkspaceInheritedResource,
} from "@/lib/gateway/client"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const statusMeta = {
  Accepted: { icon: CircleDashed, label: "Accepted", variant: "pending" },
  Ready: { icon: CheckCircle2, label: "Ready", variant: "success" },
  NotReady: { icon: CircleAlert, label: "Not ready", variant: "warning" },
  Degraded: { icon: XCircle, label: "Degraded", variant: "destructive" },
  Error: { icon: XCircle, label: "Error", variant: "destructive" },
} satisfies Record<
  ResourceLifecycle,
  {
    icon: React.ComponentType<React.ComponentProps<"svg">>
    label: string
    variant: React.ComponentProps<typeof Badge>["variant"]
  }
>

export function InheritedResourceForm({
  label,
  orgSlug,
  resourceType,
  resources,
  workspaceSlug,
}: {
  label: string
  orgSlug: string
  resourceType: InheritedResourceType
  resources: WorkspaceInheritedResource[]
  workspaceSlug: string
}) {
  "use no memo"

  const serverSelected = React.useMemo(
    () => resources.filter((resource) => resource.selected).map((resource) => resource.name),
    [resources]
  )
  const [selected, setSelected] = React.useState(() =>
    resources.filter((resource) => resource.selected).map((resource) => resource.name)
  )
  const serverSelectedKey = serverSelected.join("\0")
  const [selectedBaselineKey, setSelectedBaselineKey] = React.useState(serverSelectedKey)
  if (selectedBaselineKey !== serverSelectedKey) {
    setSelectedBaselineKey(serverSelectedKey)
    setSelected(serverSelected)
  }
  const action = replaceWorkspaceInheritanceAction.bind(null, orgSlug, workspaceSlug, resourceType)
  const [state, formAction, pending] = React.useActionState<
    WorkspaceInheritanceFormState,
    FormData
  >(action, {})
  const [sorting, setSorting] = React.useState<SortingState>([])
  const columns = React.useMemo<ColumnDef<WorkspaceInheritedResource>[]>(
    () => [
      {
        id: "selected",
        header: "Use",
        enableSorting: false,
        cell: ({ row }) => {
          const resource = row.original
          const checked = selected.includes(resource.name)
          const locked =
            checked && (resource.consumers.length > 0 || Boolean(resource.disabled_reason))
          return (
            <Checkbox
              aria-label={`${checked ? "Unselect" : "Select"} ${resource.name}`}
              checked={checked}
              disabled={pending || locked}
              onCheckedChange={(next) =>
                setSelected((current) =>
                  next
                    ? [...current, resource.name]
                    : current.filter((name) => name !== resource.name)
                )
              }
            />
          )
        },
      },
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            className="px-0"
            type="button"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Name
          </Button>
        ),
        cell: ({ row }) => {
          const resource = row.original
          const locked =
            selected.includes(resource.name) &&
            (resource.consumers.length > 0 || Boolean(resource.disabled_reason))
          const description =
            resource.disabled_reason ??
            (locked ? "Remove all consumers before unselecting this resource." : undefined)
          return (
            <>
              <div className="font-medium break-all">{resource.name}</div>
              {description ? (
                <p className="text-muted-foreground mt-1 text-xs">{description}</p>
              ) : null}
            </>
          )
        },
      },
      {
        id: "source",
        accessorFn: () => "Organization",
        header: "Source",
        cell: () => <span className="text-muted-foreground">Organization</span>,
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <Button
            className="px-0"
            type="button"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Readiness
          </Button>
        ),
        cell: ({ row }) => {
          const meta = statusMeta[row.original.status]
          const badge = (
            <Badge variant={meta.variant}>
              <meta.icon data-icon="inline-start" />
              {meta.label}
            </Badge>
          )
          const message = row.original.message?.trim()
          if (!message) return badge
          return (
            <Tooltip>
              <TooltipTrigger asChild>{badge}</TooltipTrigger>
              <TooltipContent>{message}</TooltipContent>
            </Tooltip>
          )
        },
      },
      {
        id: "consumers",
        accessorFn: (resource) => resource.consumers.length,
        header: "Consumers",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.consumers.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {row.original.consumers.map((consumer) => {
                let pathname = `/orgs/${orgSlug}/workspaces/${workspaceSlug}`
                if (consumer.kind === "Agent") {
                  pathname = `${pathname}/agents/${encodeURIComponent(consumer.name)}/sessions/new`
                } else if (consumer.kind === "Sandbox") {
                  pathname = `${pathname}/sandboxes/update/${encodeURIComponent(consumer.name)}`
                } else if (consumer.kind === "Inference Pool") {
                  pathname = `${pathname}/inference/pools`
                }
                return (
                  <li key={`${consumer.kind}:${consumer.name}`}>
                    <Link className="hover:underline" href={{ pathname }}>
                      {consumer.kind} / {consumer.name}
                    </Link>
                  </li>
                )
              })}
            </ul>
          ),
      },
    ],
    [orgSlug, pending, selected, workspaceSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: resources,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  })

  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-4">
      {selected.map((name) => (
        <input key={name} name="names" type="hidden" value={name} />
      ))}
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Selection could not be saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="w-full min-w-0 border-b">
        <Table aria-label={`Inherited Organisation ${label}`} className="min-w-3xl">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={header.column.id === "selected" ? "w-16" : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell className="text-muted-foreground py-10 text-center" colSpan={5}>
                  No Organisation {label.toLowerCase()} are available.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end px-4 pb-6 md:px-6">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner data-icon="inline-start" /> : <ListTree data-icon="inline-start" />}
          {pending ? "Applying..." : "Apply"}
        </Button>
      </div>
    </form>
  )
}
