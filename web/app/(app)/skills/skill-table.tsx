"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Download,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { useTokenPagination } from "@/app/(app)/lens/traces/client-utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatAge, formatByteSize } from "@/lib/format"
import type { ImmutableSkill, Skill } from "./skills-client"

const columnClassName: Record<string, string> = {
  select: "w-12",
  name: "min-w-56",
  version: "w-24",
  file_count: "w-24",
  size_bytes: "w-28",
  modified_at: "w-44",
  actions: "w-14",
}

export function SkillTable({
  data,
  error,
  exporting,
  hasNextPage,
  loading,
  nextPageToken,
  selected,
  scopeLabel,
  setDeleteNames,
  setSelected,
  onEdit,
  onExport,
}: {
  data: Skill[]
  error: { message: string } | null
  exporting: boolean
  hasNextPage: boolean
  loading: boolean
  nextPageToken: string
  selected: Set<string>
  scopeLabel?: "Local" | `Inherited from ${string}`
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onEdit: (skill: ImmutableSkill) => void
  onExport: (name: string) => void
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination()
  const columns = React.useMemo(
    () =>
      createSkillColumns({
        exporting,
        selected,
        scopeLabel,
        setDeleteNames,
        setSelected,
        onEdit,
        onExport,
      }),
    [exporting, onEdit, onExport, selected, scopeLabel, setDeleteNames, setSelected]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  })

  function clearSelectionAndGoPrevious() {
    setSelected(new Set())
    goPrevious()
  }

  function clearSelectionAndGoNext() {
    setSelected(new Set())
    goNext(nextPageToken)
  }

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
            {loading ? <SkillTableSkeleton columns={columns.length} /> : null}
            {!loading && error ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-destructive h-24 text-center">
                  {error.message}
                </TableCell>
              </TableRow>
            ) : null}
            {!loading && !error && table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No skills
                </TableCell>
              </TableRow>
            ) : null}
            {!loading && !error
              ? table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={selected.has(row.original.name) && "selected"}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={`h-11 px-4 py-1.5 align-middle ${columnClassName[cell.column.id]}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : null}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 px-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={clearSelectionAndGoPrevious}
          disabled={!canGoPrevious || pending}
        >
          <ArrowLeft data-icon="inline-start" />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={clearSelectionAndGoNext}
          disabled={!hasNextPage || pending}
        >
          Next
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  )
}

function createSkillColumns({
  exporting,
  selected,
  scopeLabel,
  setDeleteNames,
  setSelected,
  onEdit,
  onExport,
}: {
  exporting: boolean
  selected: Set<string>
  scopeLabel?: "Local" | `Inherited from ${string}`
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onEdit: (skill: ImmutableSkill) => void
  onExport: (name: string) => void
}): ColumnDef<Skill>[] {
  const columns: ColumnDef<Skill>[] = [
    {
      id: "select",
      header: ({ table }) => {
        const rows = table.getRowModel().rows
        const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.original.name))
        return (
          <Checkbox
            checked={allSelected}
            aria-label="Select all skills"
            onCheckedChange={(checked) => {
              setSelected((current) => {
                const next = new Set(current)
                for (const row of rows) {
                  if (checked === true) {
                    next.add(row.original.name)
                  } else {
                    next.delete(row.original.name)
                  }
                }
                return next
              })
            }}
          />
        )
      },
      cell: ({ row }) => (
        <Checkbox
          checked={selected.has(row.original.name)}
          aria-label={`Select ${row.original.name}`}
          onCheckedChange={(checked) => {
            setSelected((current) => {
              const next = new Set(current)
              if (checked === true) {
                next.add(row.original.name)
              } else {
                next.delete(row.original.name)
              }
              return next
            })
          }}
        />
      ),
      enableSorting: false,
    },
    {
      accessorKey: "name",
      header: ({ column }) => <SortButton column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={row.original.name}>
            {row.original.name}
          </span>
          {scopeLabel ? (
            <span className="text-muted-foreground shrink-0 text-xs">{scopeLabel}</span>
          ) : null}
        </span>
      ),
    },
  ]

  columns.push({
    accessorKey: "version",
    header: ({ column }) => <SortButton column={column} label="Version" />,
    cell: ({ row }) => {
      const skill = row.original
      return <span className="text-muted-foreground whitespace-nowrap">v{skill.version}</span>
    },
  })

  columns.push(
    {
      accessorKey: "file_count",
      header: ({ column }) => <SortButton column={column} label="Files" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">{row.original.file_count}</span>
      ),
    },
    {
      accessorKey: "size_bytes",
      header: ({ column }) => <SortButton column={column} label="Size" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatByteSize(row.original.size_bytes)}
        </span>
      ),
    }
  )

  columns.push(
    {
      accessorKey: "modified_at",
      header: ({ column }) => <SortButton column={column} label="Modified" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatAge(row.original.modified_at)}
        </span>
      ),
      sortingFn: (a, b) => {
        const left = a.original.modified_at ? Date.parse(a.original.modified_at) : 0
        const right = b.original.modified_at ? Date.parse(b.original.modified_at) : 0
        return left - right
      },
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <SkillRowActions
          exporting={exporting}
          skill={row.original}
          setDeleteNames={setDeleteNames}
          onEdit={onEdit}
          onExport={onExport}
        />
      ),
      enableSorting: false,
    }
  )

  return columns
}

function SortButton({
  column,
  label,
}: {
  column: { toggleSorting: (desc?: boolean) => void; getIsSorted: () => false | "asc" | "desc" }
  label: string
}) {
  return (
    <Button
      className="-ml-2"
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown />
    </Button>
  )
}

function SkillRowActions({
  exporting,
  skill,
  setDeleteNames,
  onEdit,
  onExport,
}: {
  exporting: boolean
  skill: Skill
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
  onEdit: (skill: ImmutableSkill) => void
  onExport: (name: string) => void
}) {
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8">
            <span className="sr-only">Open skill menu</span>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {skill.can_modify ? (
              <DropdownMenuItem onSelect={() => onEdit(skill)}>
                <Pencil />
                Edit
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={exporting} onSelect={() => onExport(skill.name)}>
              {exporting ? <Spinner /> : <Download />}
              Export
            </DropdownMenuItem>
            {skill.can_delete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteNames([skill.name])}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SkillTableSkeleton({ columns }: { columns: number }) {
  return Array.from({ length: 8 }, (_, index) => (
    <TableRow key={index}>
      {Array.from({ length: columns }, (_, column) => (
        <TableCell key={column} className="h-11 px-4 py-1.5">
          <Skeleton className="h-4 w-full max-w-32" />
        </TableCell>
      ))}
    </TableRow>
  ))
}
