"use client"

import * as React from "react"
import { toast } from "sonner"
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
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Globe, LogOut, Monitor, MoreHorizontal } from "lucide-react"
import { formatTimestampWithAge } from "@/lib/format"
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
import type { SVGProps } from "react"
import type { Auth } from "@/lib/auth"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"

type SessionRow = Awaited<ReturnType<Auth["api"]["listSessions"]>>[number]
type IconComponent = React.ComponentType<SVGProps<SVGSVGElement>>

const layout: Record<string, AdminColumnLayout> = {
  current: { minWidth: 112, width: 112 },
  createdAt: { minWidth: 224, width: 224 },
  updatedAt: { minWidth: 224, width: 224 },
  os: { minWidth: 144, width: 144 },
  browser: { minWidth: 144, width: 144 },
  actions: { minWidth: 64, width: 64, pin: "end" },
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

  const columns = React.useMemo<ColumnDef<SessionRow>[]>(
    () => [
      {
        id: "current",
        accessorFn: (row) => Number(row.token === currentToken),
        header: () => <span className="sr-only">Current session</span>,
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
        header: "Created",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestampWithAge(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "updatedAt",
        accessorFn: (row) => row.updatedAt,
        header: "Last seen",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestampWithAge(row.original.updatedAt)}
          </span>
        ),
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
  })

  return (
    <AdminDataGrid
      ariaLabel="Account sessions"
      emptyState={<p className="text-muted-foreground py-8 text-center">No sessions found.</p>}
      layout={layout}
      rows={sessions}
      table={table}
    />
  )
}

function SessionUserAgentValue({ kind, value }: { kind: "browser" | "os"; value?: string | null }) {
  const parsed = readUserAgent(value)
  const label = kind === "os" ? parsed.os : parsed.browser
  if (!label) return <span className="text-muted-foreground">_</span>

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
    os: parsed.os.name?.trim() || null,
    browser: parsed.browser.name?.trim() || null,
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
  const [state, action, pending] = React.useActionState(
    async (state: DeleteSessionFormState, formData: FormData) => {
      const result = await deleteSessionAction(state, formData)
      if (result.success) {
        toast.success("Session revoked")
        setOpen(false)
      }
      return result
    },
    {}
  )
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
              variant="destructive"
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
