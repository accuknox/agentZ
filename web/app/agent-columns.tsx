"use client"

import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown, MoreHorizontal } from "lucide-react"
import type { ListAgent } from "@/lib/gateway/client"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export const agentColumns: ColumnDef<ListAgent>[] = [
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
    cell: ({ row }) => {
      const agent = row.original

      return (
        <Link href={`/agent/${agent.session_id}`} className="font-medium hover:underline">
          {agent.name}
        </Link>
      )
    },
  },
  {
    accessorFn: (agent) => agent.configuration.model.primary.name,
    id: "primaryModel",
    header: "Primary Model",
  },
  {
    accessorFn: (agent) => agent.configuration.model.primary.contextWindow,
    id: "contextWindow",
    header: "Context Window",
    cell: ({ row }) => {
      const contextWindow = row.getValue<number>("contextWindow")

      return formatNumber(contextWindow)
    },
  },
  {
    accessorFn: (agent) => agent.configuration.model.summary?.name ?? "Unknown",
    id: "summaryModel",
    header: "Summary Model",
  },
  {
    accessorKey: "created_at",
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
    cell: ({ row }) => formatDate(row.getValue("created_at")),
  },
  {
    id: "actions",
    cell: ({ row }) => {
      const agent = row.original

      return (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <span className="sr-only">Open menu</span>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/agent/${agent.session_id}`}>Chat</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/agent/update/${agent.session_id}`}>Edit</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

function formatDate(value?: string) {
  if (!value) {
    return "Unknown"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown"
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function formatNumber(value?: number) {
  if (value === undefined) {
    return "Unknown"
  }

  return new Intl.NumberFormat("en").format(value)
}
