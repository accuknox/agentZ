"use client"

import type { Route } from "next"
import Link from "next/link"
import { useState, useTransition } from "react"
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { deleteWorkspaceAction, prepareWorkspaceDeleteAction } from "@/app/(scoped)/orgs/actions"
import { DestructiveConfirmationDialog } from "@/components/destructive-confirmation-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"

type DeleteData = { confirmation: string; fingerprint: string; name: string }

/** WorkspaceTableActions provides row-scoped editing and deletion controls. */
export function WorkspaceTableActions({
  name,
  orgSlug,
  workspaceId,
  workspaceSlug,
}: {
  name: string
  orgSlug: string
  workspaceId: string
  workspaceSlug: string
}) {
  const [deleteData, setDeleteData] = useState<DeleteData>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const editHref = `/orgs/${orgSlug}/workspaces/manage/${workspaceSlug}` as Route

  const prepareDelete = () => {
    startTransition(async () => {
      const result = await prepareWorkspaceDeleteAction(orgSlug, workspaceId)
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      setDeleteData(result)
      setDeleteOpen(true)
    })
  }

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
                <Pencil />
                Edit
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={prepareDelete} variant="destructive">
              {pending ? <Spinner /> : <Trash2 />}
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {deleteData ? (
        <DestructiveConfirmationDialog
          action={deleteWorkspaceAction.bind(null, orgSlug, workspaceId)}
          confirmation={deleteData.confirmation}
          fingerprint={deleteData.fingerprint}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          showTrigger={false}
          submitLabel="Delete Workspace"
          successMessage="Workspace deleted"
          title={`Delete ${deleteData.name}?`}
        />
      ) : null}
    </div>
  )
}
