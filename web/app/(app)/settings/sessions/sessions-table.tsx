"use client"

import * as React from "react"
import Bowser from "bowser"
import {
  Android,
  AppleDark,
  Arc,
  BraveBrowser,
  Chrome,
  Chromium,
  DuckDuckGo,
  Edge,
  Firefox,
  Linux,
  Opera,
  Safari,
  Ubuntu,
  Windows,
} from "@ridemountainpig/svgl-react"
import type { ColumnDef } from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, Globe, LogOut, Monitor, MoreHorizontal } from "lucide-react"
import { dayjs } from "@/lib/dayjs"
import type { DeleteSessionFormState } from "@/data/types"
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
import type { SVGProps } from "react"
import type { Auth } from "@/lib/auth"

type SessionRow = Awaited<ReturnType<Auth["api"]["listSessions"]>>[number]
type IconComponent = React.ComponentType<SVGProps<SVGSVGElement>>

const columnClassName: Record<string, string> = {
  current: "w-14",
  createdAt: "w-56",
  updatedAt: "w-56",
  os: "w-36",
  browser: "w-36",
  actions: "w-16",
}

const browserIcons: Record<string, IconComponent> = {
  Arc: Arc,
  "Brave Browser": BraveBrowser,
  Chrome: Chrome,
  Chromium: Chromium,
  "DuckDuckGo Browser": DuckDuckGo,
  Edge: Edge,
  Firefox: Firefox,
  Opera: Opera,
  Safari: Safari,
}

const osIcons: Record<string, IconComponent> = {
  Android: Android,
  Linux: Linux,
  MacOS: AppleDark,
  Ubuntu: Ubuntu,
  Windows: Windows,
  iOS: AppleDark,
}

export function SessionsTable({
  currentToken,
  deleteSessionAction,
  sessions,
}: {
  currentToken: string
  deleteSessionAction: (
    state: DeleteSessionFormState,
    formData: FormData
  ) => Promise<DeleteSessionFormState>
  sessions: SessionRow[]
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "current", desc: true },
    { id: "updatedAt", desc: true },
  ])

  const columns = React.useMemo<ColumnDef<SessionRow>[]>(
    () => [
      {
        id: "current",
        accessorFn: (row) => Number(row.token === currentToken),
        header: "",
        cell: ({ row }) =>
          row.original.token === currentToken ? (
            <Badge variant="success">
              <Monitor data-icon="inline-start" />
              Current
            </Badge>
          ) : null,
      },
      {
        id: "createdAt",
        accessorFn: (row) => row.createdAt,
        header: ({ column }) => (
          <Button
            className="-ml-2"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Created
            <ArrowUpDown />
          </Button>
        ),
        cell: ({ row }) => <span>{formatDateTime(row.original.createdAt)}</span>,
      },
      {
        id: "updatedAt",
        accessorFn: (row) => row.updatedAt,
        header: ({ column }) => (
          <Button
            className="-ml-2"
            variant="ghost"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Last seen
            <ArrowUpDown />
          </Button>
        ),
        cell: ({ row }) => <span>{formatDateTime(row.original.updatedAt)}</span>,
      },
      {
        id: "os",
        accessorFn: (row) => readUserAgent(row.userAgent).os,
        header: "OS",
        cell: ({ row }) => <SessionUserAgentValue kind="os" value={row.original.userAgent} />,
      },
      {
        id: "browser",
        accessorFn: (row) => readUserAgent(row.userAgent).browser,
        header: "Browser",
        cell: ({ row }) => <SessionUserAgentValue kind="browser" value={row.original.userAgent} />,
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DeleteSessionButton
            currentToken={currentToken}
            deleteSessionAction={deleteSessionAction}
            session={row.original}
          />
        ),
      },
    ],
    [currentToken, deleteSessionAction]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: sessions,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  })

  return (
    <div className="min-w-0 space-y-4">
      <div className="w-full min-w-0 border-b">
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
                  No sessions
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function SessionUserAgentValue({ kind, value }: { kind: "browser" | "os"; value?: string | null }) {
  const parsed = readUserAgent(value)
  const label = kind === "os" ? parsed.os : parsed.browser
  const Icon = kind === "os" ? (osIcons[label] ?? Globe) : (browserIcons[label] ?? Globe)

  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{label}</span>
    </div>
  )
}

function readUserAgent(value?: string | null) {
  const parsed = Bowser.parse(value ?? "")

  return {
    os: parsed.os.name?.trim() || "-",
    browser: parsed.browser.name?.trim() || "-",
  }
}

function DeleteSessionButton({
  currentToken,
  deleteSessionAction,
  session,
}: {
  currentToken: string
  deleteSessionAction: (
    state: DeleteSessionFormState,
    formData: FormData
  ) => Promise<DeleteSessionFormState>
  session: SessionRow
}) {
  const [open, setOpen] = React.useState(false)
  const [state, action, pending] = React.useActionState(deleteSessionAction, {})
  const isCurrent = session.token === currentToken

  return (
    <>
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={isCurrent}
              title={isCurrent ? "The current session cannot be revoked." : "Open menu"}
            >
              <span className="sr-only">
                {isCurrent ? "Current session cannot be revoked" : "Open menu"}
              </span>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive"
              onSelect={(event) => {
                event.preventDefault()
                setOpen(true)
              }}
            >
              <LogOut />
              Revoke
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke session?</DialogTitle>
            <DialogDescription>
              This will sign out that device immediately. This action cannot be undone.
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
              <input type="hidden" name="token" value={session.token} />
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? <Spinner /> : <LogOut />}
                Revoke
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function formatDateTime(value: Date | string) {
  const date = dayjs(value)
  if (!date.isValid()) {
    return "-"
  }

  return `${date.format("MMM D, YYYY, h:mm A")} (${date.fromNow()})`
}
