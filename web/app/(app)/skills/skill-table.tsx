"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type Column,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { useTokenPagination } from "@/lib/use-token-pagination"
import { AgentGettingReady } from "@/components/agent-readiness"
import { TablePagination } from "@/components/table-pagination"
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
  agents: "w-52",
  modified_at: "w-44",
  actions: "w-14",
}

export function SkillTable({
  data,
  disabled,
  error,
  exporting,
  hasNextPage,
  showAgents,
  showImmutable,
  loading,
  nextPageToken,
  selected,
  setSelected,
  onDelete,
  onEdit,
  onExport,
}: {
  data: Skill[]
  disabled: boolean
  error: { message: string } | null
  exporting: boolean
  hasNextPage: boolean
  showAgents: boolean
  showImmutable: boolean
  loading: boolean
  nextPageToken: string
  selected: Set<string>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onDelete: (key: string) => void
  onEdit: (skill: ImmutableSkill) => void
  onExport: (key: string) => void
}) {
  "use no memo"

  const [sorting, setSorting] = React.useState<SortingState>([])
  const { canGoPrevious, goNext, goPrevious, pending } = useTokenPagination({
    pageTokenKey: "page_token",
    tokenStackKey: "token_stack",
  })
  const columns = React.useMemo(
    () =>
      createSkillColumns({
        disabled,
        exporting,
        selected,
        showAgents,
        showImmutable,
        setSelected,
        onDelete,
        onEdit,
        onExport,
      }),
    [
      disabled,
      exporting,
      onEdit,
      onExport,
      selected,
      setSelected,
      onDelete,
      showAgents,
      showImmutable,
    ]
  )

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    getRowId: (row) => row.key,
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
            {disabled ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <AgentGettingReady className="text-muted-foreground inline-flex items-center gap-2 text-sm" />
                </TableCell>
              </TableRow>
            ) : null}
            {!disabled && loading ? <SkillTableSkeleton columns={columns.length} /> : null}
            {!disabled && !loading && error ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-destructive h-24 text-center">
                  {error.message}
                </TableCell>
              </TableRow>
            ) : null}
            {!disabled && !loading && !error && table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No skills
                </TableCell>
              </TableRow>
            ) : null}
            {!disabled && !loading && !error
              ? table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={selected.has(row.original.key) && "selected"}>
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
      <TablePagination
        canGoNext={!disabled && hasNextPage}
        canGoPrevious={!disabled && canGoPrevious}
        goNext={clearSelectionAndGoNext}
        goPrevious={clearSelectionAndGoPrevious}
        pending={pending}
      />
    </div>
  )
}

function createSkillColumns({
  disabled,
  exporting,
  selected,
  showAgents,
  showImmutable,
  setSelected,
  onDelete,
  onEdit,
  onExport,
}: {
  disabled: boolean
  exporting: boolean
  selected: Set<string>
  showAgents: boolean
  showImmutable: boolean
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onDelete: (key: string) => void
  onEdit: (skill: ImmutableSkill) => void
  onExport: (key: string) => void
}): ColumnDef<Skill>[] {
  const columns: ColumnDef<Skill>[] = [
    {
      id: "select",
      header: ({ table }) => {
        const rows = table.getRowModel().rows
        const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.original.key))
        return (
          <Checkbox
            disabled={disabled}
            checked={allSelected}
            aria-label="Select all skills"
            onCheckedChange={(checked) => {
              setSelected((current) => {
                const next = new Set(current)
                for (const row of rows) {
                  if (checked === true) {
                    next.add(row.original.key)
                  } else {
                    next.delete(row.original.key)
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
          checked={selected.has(row.original.key)}
          aria-label={`Select ${row.original.name}`}
          onCheckedChange={(checked) => {
            setSelected((current) => {
              const next = new Set(current)
              if (checked === true) {
                next.add(row.original.key)
              } else {
                next.delete(row.original.key)
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
        <span className="block min-w-0 truncate font-medium" title={row.original.name}>
          {row.original.name}
        </span>
      ),
    },
  ]

  if (showImmutable) {
    columns.push({
      accessorKey: "version",
      header: ({ column }) => <SortButton column={column} label="Version" />,
      cell: ({ row }) => {
        const skill = row.original
        return skill.type === "immutable" ? (
          <span className="text-muted-foreground whitespace-nowrap">v{skill.version}</span>
        ) : null
      },
    })
  }

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

  if (showAgents) {
    columns.push({
      id: "agents",
      header: "Agents",
      cell: ({ row }) => (
        <AgentsSummary agents={row.original.type === "immutable" ? row.original.agents : []} />
      ),
      enableSorting: false,
    })
  }

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
          onDelete={onDelete}
          onEdit={onEdit}
          onExport={onExport}
        />
      ),
      enableSorting: false,
    }
  )

  return columns
}

function SortButton({ column, label }: { column: Column<Skill>; label: string }) {
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

function AgentsSummary({ agents }: { agents: ImmutableSkill["agents"] }) {
  if (agents.length === 0) {
    return <span className="text-muted-foreground">-</span>
  }
  const sorted = agents.toSorted()
  const summary =
    sorted.length <= 2
      ? sorted.join(", ")
      : `${sorted.slice(0, 2).join(", ")}, +${sorted.length - 2}`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="cursor-default">{summary}</code>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{sorted.join(", ")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function SkillRowActions({
  exporting,
  skill,
  onDelete,
  onEdit,
  onExport,
}: {
  exporting: boolean
  skill: Skill
  onDelete: (key: string) => void
  onEdit: (skill: ImmutableSkill) => void
  onExport: (key: string) => void
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
            {skill.type === "immutable" && skill.can_modify ? (
              <DropdownMenuItem onSelect={() => onEdit(skill)}>
                <Pencil />
                Edit
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={exporting} onSelect={() => onExport(skill.key)}>
              {exporting ? <Spinner /> : <Download />}
              Export
            </DropdownMenuItem>
            {skill.type === "mutable" || skill.can_delete ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(skill.key)}>
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
