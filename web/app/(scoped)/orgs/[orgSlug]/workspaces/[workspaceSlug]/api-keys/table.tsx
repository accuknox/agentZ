"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Badge } from "@/components/ui/badge"
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
  DropdownMenuContent,
  DropdownMenuGroup,
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
import type { WorkspaceAPIKey } from "@/data/api-key.queries"
import type { DeleteAPIKeyFormState } from "@/data/types"
import { formatAge } from "@/lib/format"

const columnClassName: Record<string, string> = {
  name: "w-40",
  key: "w-36",
  targets: "min-w-52",
  status: "w-28",
  expiresAt: "w-28",
  age: "w-28",
  actions: "w-14",
}

export function APIKeysTable({
  canDelete,
  deleteAPIKeyAction,
  keys,
}: {
  canDelete: boolean
  deleteAPIKeyAction: (
    state: DeleteAPIKeyFormState,
    formData: FormData
  ) => Promise<DeleteAPIKeyFormState>
  keys: WorkspaceAPIKey[]
}) {
  "use no memo"

  const columns = React.useMemo<ColumnDef<WorkspaceAPIKey>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => <span>{row.original.name || "-"}</span>,
      },
      {
        id: "key",
        header: "Key",
        cell: ({ row }) => (
          <code>
            {row.original.prefix || "key_"}...{row.original.id.slice(-6)}
          </code>
        ),
      },
      {
        id: "targets",
        header: "Targets",
        cell: ({ row }) => <APIKeyTargets targets={row.original.targets} />,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <APIKeyStatus apiKey={row.original} />,
      },
      {
        id: "expiresAt",
        header: "Expires",
        cell: ({ row }) => <span>{formatAge(row.original.expiresAt)}</span>,
      },
      {
        id: "age",
        header: "Age",
        cell: ({ row }) => <span>{formatAge(row.original.createdAt)}</span>,
      },
      {
        id: "actions",
        cell: ({ row }) =>
          canDelete && !row.original.revokedAt ? (
            <DeleteAPIKeyButton deleteAPIKeyAction={deleteAPIKeyAction} keyID={row.original.id} />
          ) : null,
      },
    ],
    [canDelete, deleteAPIKeyAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ data: keys, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <div className="w-full min-w-0 overflow-x-auto border-b">
      <Table className="w-full table-fixed">
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
                No API keys in this Workspace
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function APIKeyTargets({ targets }: { targets: WorkspaceAPIKey["targets"] }) {
  const workflowsByAgent = new Map<string, string[]>()
  const agentNames: string[] = []
  for (const target of targets) {
    if (target.targetType === "agent") {
      agentNames.push(target.agentName)
      continue
    }
    const workflowNames = workflowsByAgent.get(target.agentName) ?? []
    workflowNames.push(target.workflowName)
    workflowsByAgent.set(target.agentName, workflowNames)
  }

  const details = [
    ...agentNames.toSorted(),
    ...[...workflowsByAgent]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([agentName, workflowNames]) => `${agentName}: ${workflowNames.toSorted().join(", ")}`),
  ]
  const summary =
    details.length <= 2
      ? details.join(", ")
      : `${details.slice(0, 2).join(", ")}, +${details.length - 2}`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="block max-w-64 cursor-default truncate">{summary}</code>
        </TooltipTrigger>
        <TooltipContent sideOffset={6} className="max-w-96 whitespace-pre-line">
          {details.join("\n")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function APIKeyStatus({ apiKey }: { apiKey: WorkspaceAPIKey }) {
  if (apiKey.revokedAt) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className="cursor-default" variant="destructive">
              Revoked
            </Badge>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>
            {apiKey.revokedReason ?? "Workspace access was revoked."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (!apiKey.enabled) {
    return <Badge variant="pending">Disabled</Badge>
  }
  if (apiKey.expired) {
    return <Badge variant="pending">Expired</Badge>
  }
  return <Badge variant="success">Active</Badge>
}

function DeleteAPIKeyButton({
  deleteAPIKeyAction,
  keyID,
}: {
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
    React.startTransition(() => router.refresh())
  }, [router, state.success])

  return (
    <>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <span className="sr-only">Open API key menu</span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem
                variant="destructive"
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
              This immediately denies every request using this key.
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
