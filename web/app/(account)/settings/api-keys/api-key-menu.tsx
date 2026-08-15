"use client"

import type { Route } from "next"
import Link from "next/link"
import { Building2, ChevronDown, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function APIKeyWorkspaceMenu({
  workspaces,
}: {
  workspaces: { id: string; name: string }[]
}) {
  if (!workspaces.length) return <Button disabled>New API key</Button>

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <KeyRound data-icon="inline-start" />
          New API key
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Choose a workspace</DropdownMenuLabel>
        <DropdownMenuGroup>
          {workspaces.map((workspace) => (
            <DropdownMenuItem asChild key={workspace.id}>
              <Link href={`/settings/api-keys?create=${encodeURIComponent(workspace.id)}` as Route}>
                <Building2 />
                <span className="truncate" title={workspace.name}>
                  {workspace.name}
                </span>
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
