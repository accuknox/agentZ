"use client"

import type { Route } from "next"
import Link from "next/link"
import { ChevronDown, KeyRound } from "lucide-react"
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
  if (!workspaces.length) return <Button disabled>New API Key</Button>

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <KeyRound data-icon="inline-start" />
          New API Key
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Choose a Workspace</DropdownMenuLabel>
        <DropdownMenuGroup>
          {workspaces.map((workspace) => (
            <DropdownMenuItem asChild key={workspace.id}>
              <Link href={`/settings/api-keys?create=${encodeURIComponent(workspace.id)}` as Route}>
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
