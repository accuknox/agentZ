"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Trash2 } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { dayjs } from "@/lib/dayjs"
import type { DeleteAPIKeyFormState } from "@/data/types"
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
import type { Auth } from "@/lib/auth"

type APIKeyRow = Awaited<ReturnType<Auth["api"]["listApiKeys"]>>["apiKeys"][number]

const columnClassName: Record<string, string> = {
  name: "w-40",
  start: "w-32",
  scope: "w-32",
  expiresAt: "w-72",
  createdAt: "w-72",
  actions: "w-16",
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
        id: "start",
        header: "Key",
        cell: ({ row }) => <code>{row.original.start || row.original.prefix || "-"}...</code>,
      },
      {
        id: "scope",
        header: "Scope",
        cell: ({ row }) => <APIKeyScope permissions={row.original.permissions} />,
      },
      {
        id: "expiresAt",
        header: "Expires",
        cell: ({ row }) => <span>{formatDateTime(row.original.expiresAt)}</span>,
      },
      {
        id: "createdAt",
        header: "Created",
        cell: ({ row }) => <span>{formatDateTime(row.original.createdAt)}</span>,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DeleteAPIKeyButton deleteAPIKeyAction={deleteAPIKeyAction} keyID={row.original.id} />
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

function APIKeyScope({ permissions }: { permissions?: Record<string, string[]> | null }) {
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
    return <Badge variant="outline">Invalid</Badge>
  }

  const summary =
    agentNames.length <= 2
      ? agentNames.join(", ")
      : `${agentNames[0]}, ${agentNames[1]}, +${agentNames.length - 2}`

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
