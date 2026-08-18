"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import type { Sandbox } from "@/lib/gateway/client"
import { createSandboxColumns } from "./sandbox-columns"
import { TokenTablePagination } from "@/components/table-pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { DeleteSandboxFormState } from "@/data/types"
import type { Route } from "next"

const columnClassName: Record<string, string> = {
  name: "w-52",
  packages: "w-24",
  allowed_hosts: "w-24",
  models: "w-32",
  mcps: "w-16",
  skills: "w-20",
  created_by: "hidden lg:table-cell w-28",
  last_modified_by: "hidden lg:table-cell w-28",
  created_at: "w-28",
  actions: "w-20",
}

export function SandboxTable({
  sandboxes,
  basePath,
  hasNextPage,
  nextPageToken,
  deleteSandboxAction,
  showOrganisation,
}: {
  sandboxes: Sandbox[]
  basePath: string
  hasNextPage: boolean
  nextPageToken: string
  showOrganisation: boolean
  deleteSandboxAction: (
    name: string,
    state: DeleteSandboxFormState,
    formData: FormData
  ) => Promise<DeleteSandboxFormState>
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const router = useRouter()
  const columns = React.useMemo(
    () => createSandboxColumns(basePath, deleteSandboxAction, showOrganisation),
    [basePath, deleteSandboxAction, showOrganisation]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: sandboxes,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  })

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="w-full min-w-0 border-b">
        <Table className="w-full table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={`h-8 px-4 ${columnClassName[header.column.id]}`}
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
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={row.original.can_modify ? "cursor-pointer" : undefined}
                  role={row.original.can_modify ? "link" : undefined}
                  tabIndex={row.original.can_modify ? 0 : undefined}
                  onClick={() => {
                    if (row.original.can_modify) {
                      router.push(
                        `${basePath}/update/${encodeURIComponent(row.original.name)}` as Route
                      )
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!row.original.can_modify || (event.key !== "Enter" && event.key !== " ")) {
                      return
                    }

                    event.preventDefault()
                    router.push(
                      `${basePath}/update/${encodeURIComponent(row.original.name)}` as Route
                    )
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={`h-11 px-4 py-1.5 ${columnClassName[cell.column.id]}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <span className="text-muted-foreground">_</span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <TokenTablePagination hasNextPage={hasNextPage} nextPageToken={nextPageToken} />
    </div>
  )
}
