"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { dayjs } from "@/lib/dayjs"
import type { DeleteAPIKeyFormState } from "@/data/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { agentAPIKeyConfigID, webhookAPIKeyConfigID } from "@/lib/api-key-config"

type APIKeyRow = {
  id: string
  name?: string | null
  configId: string
  start?: string | null
  prefix?: string | null
  permissions?: Record<string, string[]> | null
  expiresAt?: Date | string | null
  createdAt: Date | string
}

const columnClassName: Record<string, string> = {
  name: "w-44",
  type: "w-20",
  start: "w-36",
  scope: "min-w-56",
  expiresAt: "w-28",
  age: "w-28",
  actions: "w-14",
}

export function APIKeysTable({
  deleteAPIKeyAction,
  keys,
}: {
  deleteAPIKeyAction: (
    state: DeleteAPIKeyFormState,
    formData: FormData
  ) => Promise<DeleteAPIKeyFormState>
  keys: APIKeyRow[]
}) {
  "use no memo"

  const columns = React.useMemo<ColumnDef<APIKeyRow>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => <span>{row.original.name || "-"}</span>,
      },
      {
        id: "type",
        header: "Type",
        cell: ({ row }) => <span>{apiKeyTypeLabel(row.original.configId)}</span>,
      },
      {
        id: "start",
        header: "Key",
        cell: ({ row }) => <code>{row.original.start || row.original.prefix || "-"}...</code>,
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => (
          <APIKeyScope configId={row.original.configId} permissions={row.original.permissions} />
        ),
      },
      {
        id: "expiresAt",
        header: "Expires",
        cell: ({ row }) => <span>{formatDateTime(row.original.expiresAt)}</span>,
      },
      {
        id: "age",
        header: "Age",
        cell: ({ row }) => <span>{formatAge(row.original.createdAt)}</span>,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DeleteAPIKeyButton
            configId={row.original.configId}
            deleteAPIKeyAction={deleteAPIKeyAction}
            keyID={row.original.id}
          />
        ),
      },
    ],
    [deleteAPIKeyAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: keys,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="w-full min-w-0 overflow-hidden border-b">
      <Table className="table-auto">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={`h-8 px-4 ${columnClassName[header.column.id] ?? ""}`}
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
          {table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={`h-11 px-4 py-1.5 align-middle ${columnClassName[cell.column.id] ?? ""}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No API keys
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function APIKeyScope({
  configId,
  permissions,
}: {
  configId: string
  permissions?: Record<string, string[]> | null
}) {
  if (configId === webhookAPIKeyConfigID) {
    const webhook = permissions?.webhook ?? []
    if (webhook.includes("all")) {
      return <code>*</code>
    }

    const workflowsByAgent = new Map<string, string[]>()
    for (const scope of webhook) {
      const [kind, agentName, workflowName, extra] = scope.split(":")
      if (kind !== "workflow" || !agentName || !workflowName || extra) {
        continue
      }

      const workflows = workflowsByAgent.get(agentName) ?? []
      workflows.push(workflowName)
      workflowsByAgent.set(agentName, workflows)
    }

    if (workflowsByAgent.size === 0) {
      return <span>Invalid</span>
    }

    const grouped = [...workflowsByAgent.entries()]
      .map(([agentName, workflowNames]) => ({
        agentName,
        workflowNames: workflowNames.toSorted(),
      }))
      .toSorted((left, right) => left.agentName.localeCompare(right.agentName))

    const summary =
      grouped.length <= 2
        ? grouped
            .map(({ agentName, workflowNames }) => `${agentName}: ${workflowNames.length}`)
            .join(", ")
        : `${grouped
            .slice(0, 2)
            .map(({ agentName, workflowNames }) => `${agentName}: ${workflowNames.length}`)
            .join(", ")}, +${grouped.length - 2} agents`
    const details = grouped
      .map(({ agentName, workflowNames }) => `${agentName}: ${workflowNames.join(", ")}`)
      .join("\n")

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <code className="cursor-default">{summary}</code>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="whitespace-pre-line">
            {details}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  const opencode = permissions?.opencode ?? []
  if (opencode.includes("all")) {
    return <code>*</code>
  }

  const agentNames = opencode
    .flatMap((value) => {
      if (!value.startsWith("agent:")) {
        return []
      }
      const agentName = value.slice("agent:".length).trim()
      return agentName ? [agentName] : []
    })
    .toSorted()

  if (agentNames.length === 0) {
    return <span>Invalid</span>
  }

  const summary =
    agentNames.length <= 2
      ? agentNames.join(", ")
      : `${agentNames.slice(0, 2).join(", ")}, +${agentNames.length - 2}`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="cursor-default">{summary}</code>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{agentNames.join(", ")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function apiKeyTypeLabel(configId: string) {
  if (configId === agentAPIKeyConfigID) {
    return "Agent"
  }
  if (configId === webhookAPIKeyConfigID) {
    return "Webhook"
  }
  return "Unknown"
}

function DeleteAPIKeyButton({
  configId,
  deleteAPIKeyAction,
  keyID,
}: {
  configId: string
  deleteAPIKeyAction: (
    state: DeleteAPIKeyFormState,
    formData: FormData
  ) => Promise<DeleteAPIKeyFormState>
  keyID: string
}) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [state, action, pending] = React.useActionState(deleteAPIKeyAction, {})
  const shown = open && !state.success

  React.useEffect(() => {
    if (!state.success) {
      return
    }
    React.startTransition(() => {
      router.refresh()
    })
  }, [router, state.success])

  return (
    <>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={(event) => {
                  event.preventDefault()
                  setOpen(true)
                }}
              >
                <Trash2 />
                Revoke
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={shown} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              This immediately breaks every client using this key.
            </DialogDescription>
          </DialogHeader>
          {state.error ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {state.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <form action={action}>
              <input type="hidden" name="configId" value={configId} />
              <input type="hidden" name="keyID" value={keyID} />
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? <Spinner aria-hidden="true" /> : <Trash2 data-icon="inline-start" />}
                Revoke
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function formatDateTime(value: Date | string | null | undefined) {
  if (!value) {
    return "Never"
  }

  const date = dayjs(value)
  if (!date.isValid()) {
    return "-"
  }

  return `${date.format("MMM D, YYYY, h:mm A")} (${date.fromNow()})`
}

function formatAge(value: Date | string | null | undefined) {
  if (!value) {
    return "Unknown"
  }

  const date = dayjs(value)
  if (!date.isValid()) {
    return "Unknown"
  }

  return date.fromNow()
}
