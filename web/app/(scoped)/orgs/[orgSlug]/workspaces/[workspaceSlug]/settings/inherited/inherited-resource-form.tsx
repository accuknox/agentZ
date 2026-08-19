"use client"

import Link from "next/link"
import * as React from "react"
import { toast } from "sonner"
import { CheckCircle2, CircleAlert, CircleDashed, ListTree, XCircle } from "lucide-react"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { renderMcpServerIcon } from "@/app/(app)/mcps/catalog"
import { ProviderIcon } from "@/app/(app)/inference/providers/provider-shared"
import {
  replaceWorkspaceInheritanceAction,
  type WorkspaceInheritanceFormState,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import type {
  InheritedResourceType,
  ResourceLifecycle,
  WorkspaceInheritedResource,
} from "@/lib/gateway/client"
import { DisabledReason, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const layout: Record<string, AdminColumnLayout> = {
  selected: { minWidth: 64, width: 64, pin: "start" },
  name: { minWidth: 224, contentMaxWidth: 320, pin: "start" },
  source: { minWidth: 144, width: 144 },
  status: { minWidth: 128, width: 128 },
  consumers: { minWidth: 256, contentMaxWidth: 384 },
}

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
  displayNames,
  iconSources,
  label,
  orgSlug,
  resourceType,
  resources,
  workspaceSlug,
}: {
  displayNames?: Record<string, string>
  iconSources: Record<string, string>
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
  const [state, formAction, pending] = React.useActionState<
    WorkspaceInheritanceFormState,
    FormData
  >(async (state, formData) => {
    const result = await replaceWorkspaceInheritanceAction(
      orgSlug,
      workspaceSlug,
      resourceType,
      state,
      formData
    )
    if (result.saved) toast.success("Inherited resources updated")
    return result
  }, {})
  const columns = React.useMemo<ColumnDef<WorkspaceInheritedResource>[]>(
    () => [
      {
        id: "selected",
        header: "Use",
        cell: ({ row }) => {
          const resource = row.original
          const displayName = displayNames ? displayNames[resource.name] : resource.name
          const checked = selected.includes(resource.name)
          const locked =
            checked && (resource.consumers.length > 0 || Boolean(resource.disabled_reason))
          const checkbox = (
            <Checkbox
              aria-busy={pending}
              aria-label={`${checked ? "Unselect" : "Select"} ${displayName}`}
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
          if (!locked || pending) return checkbox
          return (
            <DisabledReason
              reason={
                resource.disabled_reason ?? "Remove all consumers before unselecting this resource."
              }
            >
              {checkbox}
            </DisabledReason>
          )
        },
      },
      {
        id: "name",
        accessorFn: (resource) => (displayNames ? displayNames[resource.name] : resource.name),
        header: "Name",
        cell: ({ row }) => {
          const resource = row.original
          const displayName = displayNames ? displayNames[resource.name] : resource.name
          const iconSource = iconSources[resource.name]
          const locked =
            selected.includes(resource.name) &&
            (resource.consumers.length > 0 || Boolean(resource.disabled_reason))
          const description =
            resource.disabled_reason ??
            (locked ? "Remove all consumers before unselecting this resource." : undefined)
          return (
            <>
              <div className="flex min-w-0 items-center gap-2">
                {resourceType === "mcp_connection" && iconSource
                  ? renderMcpServerIcon(iconSource, {
                      "aria-hidden": "true",
                      className: "size-4 shrink-0",
                    })
                  : null}
                {resourceType === "inference_provider" && iconSource ? (
                  <ProviderIcon className="size-4 shrink-0" provider={iconSource} />
                ) : null}
                <div className="font-medium break-all">{displayName}</div>
              </div>
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
        header: "Readiness",
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
        cell: ({ row }) =>
          row.original.consumers.length === 0 ? (
            <span className="text-muted-foreground">_</span>
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
    [displayNames, iconSources, orgSlug, pending, resourceType, selected, workspaceSlug]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: resources,
    columns,
    getCoreRowModel: getCoreRowModel(),
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
      <AdminDataGrid
        ariaLabel={`Inherited organization ${label}`}
        emptyState={
          <p className="text-muted-foreground py-8 text-center">No inherited {label} found.</p>
        }
        layout={layout}
        rows={resources}
        table={table}
      />
      <div className="flex justify-end px-4 pb-6 md:px-6">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner data-icon="inline-start" /> : <ListTree data-icon="inline-start" />}
          {pending ? "Saving…" : "Save inheritance"}
        </Button>
      </div>
    </form>
  )
}
