"use client"

import type { Route } from "next"
import Link from "next/link"
import { useState } from "react"
import { Eye, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RoleDeleteDialog } from "./role-delete"

/** RoleTableActions provides row-scoped editing and deletion controls. */
export function RoleTableActions({
  immutable,
  name,
  orgSlug,
  roleId,
}: {
  immutable: boolean
  name: string
  orgSlug: string
  roleId: string
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const editHref = `/orgs/${orgSlug}/roles/${roleId}/permissions` as Route

  return (
    <div
      className="flex justify-end"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={`Actions for ${name}`} size="icon" variant="ghost">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link href={editHref}>
                {immutable ? <Eye /> : <Pencil />}
                {immutable ? "View" : "Edit"}
              </Link>
            </DropdownMenuItem>
            {!immutable ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {!immutable ? (
        <RoleDeleteDialog
          name={name}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          orgSlug={orgSlug}
          roleId={roleId}
        />
      ) : null}
    </div>
  )
}
