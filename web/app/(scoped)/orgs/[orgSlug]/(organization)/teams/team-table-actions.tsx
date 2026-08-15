"use client"

import type { Route } from "next"
import Link from "next/link"
import { useState, useTransition } from "react"
import { MoreHorizontal, Pencil, ShieldCheck, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { deleteTeamAction, prepareTeamDeleteAction } from "@/app/(scoped)/orgs/actions"
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

export function TeamTableActions({
  name,
  orgSlug,
  teamId,
}: {
  name: string
  orgSlug: string
  teamId: string
}) {
  const root = `/orgs/${orgSlug}/teams/${teamId}`
  const [deleteData, setDeleteData] = useState<DeleteData>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  const prepareDelete = () => {
    startTransition(async () => {
      const result = await prepareTeamDeleteAction(orgSlug, teamId)
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
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuItem asChild className="whitespace-nowrap">
              <Link href={root as Route}>
                <Pencil />
                Edit
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="whitespace-nowrap">
              <Link href={`${root}/members` as Route}>
                <Users />
                Members
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="whitespace-nowrap">
              <Link href={`${root}/roles` as Route}>
                <ShieldCheck />
                Roles and access
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="whitespace-nowrap"
              disabled={pending}
              onSelect={prepareDelete}
              variant="destructive"
            >
              {pending ? <Spinner /> : <Trash2 />}
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {deleteData ? (
        <DestructiveConfirmationDialog
          action={deleteTeamAction.bind(null, orgSlug, teamId)}
          confirmation={deleteData.confirmation}
          fingerprint={deleteData.fingerprint}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
          showTrigger={false}
          submitLabel="Delete Team"
          successMessage="Team deleted"
          title={`Delete ${deleteData.name}?`}
        />
      ) : null}
    </div>
  )
}
