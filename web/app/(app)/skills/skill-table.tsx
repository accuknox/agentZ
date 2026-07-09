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
import { ArrowLeft, ArrowRight, ArrowUpDown, Download, MoreHorizontal, Trash2 } from "lucide-react"
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
import { formatByteSize, formatTimestampWithAge } from "@/lib/format"
import type { Skill } from "./skills-client"

const columnClassName: Record<string, string> = {
  select: "w-12",
  name: "min-w-56",
  fileCount: "w-28",
  sizeBytes: "w-32",
  modifiedAt: "w-44",
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
  setDeleteNames,
  setSelected,
  onExport,
}: {
  data: Skill[]
  error: Error | null
  exporting: boolean
  hasNextPage: boolean
  loading: boolean
  nextPageToken: string
  selected: Set<string>
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
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
        setDeleteNames,
        setSelected,
        onExport,
      }),
    [exporting, onExport, selected, setDeleteNames, setSelected]
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
            {loading ? <SkillTableSkeleton /> : null}
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
  setDeleteNames,
  setSelected,
  onExport,
}: {
  exporting: boolean
  selected: Set<string>
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onExport: (name: string) => void
}): ColumnDef<Skill>[] {
  return [
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
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="block min-w-0 truncate font-medium" title={row.original.name}>
          {row.original.name}
        </span>
      ),
    },
    {
      accessorKey: "fileCount",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Files
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">{row.original.fileCount}</span>
      ),
    },
    {
      accessorKey: "sizeBytes",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Size
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatByteSize(row.original.sizeBytes)}
        </span>
      ),
    },
    {
      accessorKey: "modifiedAt",
      header: ({ column }) => (
        <Button
          className="-ml-2"
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Modified
          <ArrowUpDown />
        </Button>
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatTimestampWithAge(row.original.modifiedAt)}
        </span>
      ),
      sortingFn: (a, b) => {
        const left = a.original.modifiedAt ? Date.parse(a.original.modifiedAt) : 0
        const right = b.original.modifiedAt ? Date.parse(b.original.modifiedAt) : 0
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
          onExport={onExport}
        />
      ),
      enableSorting: false,
    },
  ]
}

function SkillRowActions({
  exporting,
  skill,
  setDeleteNames,
  onExport,
}: {
  exporting: boolean
  skill: Skill
  setDeleteNames: React.Dispatch<React.SetStateAction<string[]>>
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
            <DropdownMenuItem disabled={exporting} onSelect={() => onExport(skill.name)}>
              {exporting ? <Spinner /> : <Download />}
              Export
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => setDeleteNames([skill.name])}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SkillTableSkeleton() {
  return Array.from({ length: 6 }, (_, index) => (
    <TableRow key={index}>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.select}`}>
        <Skeleton className="size-4 rounded-sm" />
      </TableCell>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.name}`}>
        <Skeleton className="h-4 w-full max-w-56" />
      </TableCell>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.fileCount}`}>
        <Skeleton className="h-4 w-12" />
      </TableCell>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.sizeBytes}`}>
        <Skeleton className="h-4 w-16" />
      </TableCell>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.modifiedAt}`}>
        <Skeleton className="h-4 w-24" />
      </TableCell>
      <TableCell className={`h-11 px-4 py-1.5 ${columnClassName.actions}`}>
        <Skeleton className="size-8 rounded-md" />
      </TableCell>
    </TableRow>
  ))
}
