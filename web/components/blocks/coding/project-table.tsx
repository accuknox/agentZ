"use client"

import { useMemo, useState, type ReactNode } from "react"
import type { Route } from "next"
import {
  getCoreRowModel,
  // eslint-disable-next-line no-restricted-imports -- Projects uses a complete-list endpoint with client-side sorting.
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table"
import { Ellipsis, Pencil, Settings2 } from "lucide-react"
import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RelativeDateTime } from "@/components/ui/table"
import type { CodingProject } from "@/lib/gateway/client"

const columnLayout = {
  name: { minWidth: 224, contentMaxWidth: 320 },
  repository: { minWidth: 200, contentMaxWidth: 320 },
  default_branch: { minWidth: 160, contentMaxWidth: 240 },
  age: { minWidth: 104, width: 104 },
  actions: { align: "end", minWidth: 64, width: 64 },
} satisfies Record<string, AdminColumnLayout>

const columns: ColumnDef<CodingProject>[] = [
  {
    accessorKey: "name",
    header: "Name",
    enableSorting: true,
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2">
        <GitHubLight className="size-4 shrink-0 dark:hidden" aria-hidden="true" />
        <GitHubDark className="hidden size-4 shrink-0 dark:block" aria-hidden="true" />
        <span className="min-w-0 truncate font-medium" title={row.original.name}>
          {row.original.name}
        </span>
      </div>
    ),
  },
  {
    accessorKey: "repository",
    header: "Repository",
    cell: ({ row }) => (
      <span
        className="text-muted-foreground block min-w-0 truncate"
        title={row.original.repository}
      >
        {row.original.repository}
      </span>
    ),
  },
  {
    accessorKey: "default_branch",
    header: "Default branch",
    cell: ({ row }) => (
      <span
        className="text-muted-foreground block min-w-0 truncate"
        title={row.original.default_branch}
      >
        {row.original.default_branch}
      </span>
    ),
  },
  {
    id: "age",
    accessorFn: (project) => new Date(project.created_at).getTime(),
    header: "Age",
    enableSorting: true,
    cell: ({ row }) => <RelativeDateTime value={row.original.created_at} />,
  },
]

export function ProjectTable({
  projects,
  rowHref,
  emptyState,
  onProjectAction,
  pending,
}: {
  projects: CodingProject[]
  rowHref: (project: CodingProject) => Route
  emptyState: ReactNode
  onProjectAction: (project: CodingProject, action: "settings" | "rename") => void
  pending: boolean
}) {
  "use no memo"

  const [sorting, setSorting] = useState<SortingState>([{ id: "age", desc: true }])
  const tableColumns = useMemo<ColumnDef<CodingProject>[]>(
    () => [
      ...columns,
      {
        id: "actions",
        cell: ({ row }) => (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={`Project options for ${row.original.name}`}
                  disabled={pending}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onProjectAction(row.original, "settings")}>
                  <Settings2 /> Project settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onProjectAction(row.original, "rename")}>
                  <Pencil /> Rename project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [onProjectAction, pending]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: projects,
    columns: tableColumns,
    getRowId: (project) => project.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  })

  return (
    <AdminDataGrid
      ariaLabel="Projects"
      rows={projects}
      table={table}
      layout={columnLayout}
      rowHref={rowHref}
      rowAriaLabel={(project) => `Open project ${project.name}`}
      emptyState={emptyState}
    />
  )
}
