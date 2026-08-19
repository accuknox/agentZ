"use client"

import * as React from "react"
import { getCoreRowModel, type ColumnDef, useReactTable } from "@tanstack/react-table"
import { Download, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { useTokenPagination } from "@/lib/use-token-pagination"
import { AgentGettingReady } from "@/components/agent-readiness"
import { AdminDataGrid, type AdminColumnLayout } from "@/components/admin-data-grid"
import { TablePagination } from "@/components/table-pagination"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyValue, RelativeDateTime } from "@/components/ui/table"
import { formatByteSize } from "@/lib/format"
import type { ImmutableSkill, Skill } from "./skills-client"

const layout: Record<string, AdminColumnLayout> = {
  select: { minWidth: 48, width: 48, pin: "start" },
  name: { minWidth: 288, contentMaxWidth: 384, pin: "start" },
  version: { minWidth: 96, width: 96 },
  file_count: { minWidth: 96, width: 96 },
  size_bytes: { minWidth: 112, width: 112 },
  agents: { minWidth: 208, contentMaxWidth: 288 },
  created_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  last_modified_by: { minWidth: 112, width: 112, hiddenBelow: "lg" },
  modified_at: { minWidth: 176, width: 176 },
  actions: { minWidth: 64, width: 64, pin: "end" },
}

export function SkillTable({
  data,
  disabled,
  error,
  exporting,
  hasNextPage,
  showAgents,
  showImmutable,
  showOrganization,
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
  showOrganization: boolean
  loading: boolean
  nextPageToken: string
  selected: Set<string>
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
  onDelete: (key: string) => void
  onEdit: (skill: ImmutableSkill) => void
  onExport: (key: string) => void
}) {
  "use no memo"

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
        showOrganization,
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
      showOrganization,
    ]
  )

  const rows = disabled || loading || error ? [] : data
  const rowSelection = React.useMemo(
    () => Object.fromEntries(Array.from(selected, (key) => [key, true])),
    [selected]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    state: { rowSelection },
  })

  function clearSelectionAndGoPrevious() {
    setSelected(new Set())
    goPrevious()
  }

  function clearSelectionAndGoNext() {
    setSelected(new Set())
    goNext(nextPageToken)
  }

  const emptyState = disabled ? (
    <AgentGettingReady className="text-muted-foreground flex justify-center py-8 text-sm" />
  ) : loading ? (
    <p aria-busy="true" className="text-muted-foreground py-8 text-center">
      Loading skills…
    </p>
  ) : error ? (
    <p className="text-destructive py-8 text-center">{error.message}</p>
  ) : (
    <p className="text-muted-foreground py-8 text-center">No skills found.</p>
  )

  return (
    <AdminDataGrid
      ariaLabel="Skills"
      emptyState={emptyState}
      layout={layout}
      pagination={
        <TablePagination
          canGoNext={!disabled && hasNextPage}
          canGoPrevious={!disabled && canGoPrevious}
          goNext={clearSelectionAndGoNext}
          goPrevious={clearSelectionAndGoPrevious}
          pending={pending}
        />
      }
      rows={rows}
      table={table}
    />
  )
}

function createSkillColumns({
  disabled,
  exporting,
  selected,
  showAgents,
  showImmutable,
  showOrganization,
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
  showOrganization: boolean
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
    },
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium" title={row.original.name}>
            {row.original.name}
          </span>
          {showOrganization &&
          row.original.type === "immutable" &&
          row.original.scope === "Organisation" ? (
            <Badge variant="secondary">Organization</Badge>
          ) : null}
        </div>
      ),
    },
  ]

  if (showImmutable) {
    columns.push(
      {
        accessorKey: "version",
        header: "Version",
        cell: ({ row }) => {
          const skill = row.original
          return skill.type === "immutable" ? (
            <span className="text-muted-foreground whitespace-nowrap">v{skill.version}</span>
          ) : null
        },
      },
      {
        id: "created_by",
        header: "Created by",
        cell: ({ row }) =>
          row.original.type === "immutable" ? <UserAvatar {...row.original.created_by} /> : null,
      },
      {
        id: "last_modified_by",
        header: "Modified by",
        cell: ({ row }) =>
          row.original.type === "immutable" ? (
            <UserAvatar {...row.original.last_modified_by} />
          ) : null,
      }
    )
  }

  columns.push(
    {
      accessorKey: "file_count",
      header: "Files",
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">{row.original.file_count}</span>
      ),
    },
    {
      accessorKey: "size_bytes",
      header: "Size",
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
    })
  }

  columns.push(
    {
      accessorKey: "modified_at",
      header: "Modified at",
      cell: ({ row }) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {row.original.modified_at ? (
            <RelativeDateTime value={row.original.modified_at} />
          ) : (
            <EmptyValue />
          )}
        </span>
      ),
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
    }
  )

  return columns
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
            <DropdownMenuItem
              aria-busy={exporting}
              disabled={exporting}
              onSelect={() => onExport(skill.key)}
            >
              {exporting ? <Spinner /> : <Download />}
              {exporting ? "Exporting…" : "Export"}
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
