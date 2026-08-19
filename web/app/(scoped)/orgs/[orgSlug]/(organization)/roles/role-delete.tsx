"use client"

import { useActionState, useState } from "react"
import { useRouter } from "@bprogress/next/app"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  deleteOrganizationRoleAction,
  type DeleteRoleFormState,
  deleteWorkspaceRoleAction,
} from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { formatTimestamp } from "@/lib/format"

export function RoleDelete({
  name,
  orgSlug,
  roleId,
  updatedAt,
  workspaceSlug,
}: {
  name: string
  orgSlug: string
  roleId: string
  updatedAt: string
  workspaceSlug?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <section className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm">
        Last updated <time dateTime={updatedAt}>{formatTimestamp(updatedAt)}</time>.
      </p>
      <Button onClick={() => setOpen(true)} variant="destructive">
        <Trash2 data-icon="inline-start" />
        Delete
      </Button>
      <RoleDeleteDialog
        name={name}
        onOpenChange={setOpen}
        open={open}
        orgSlug={orgSlug}
        roleId={roleId}
        workspaceSlug={workspaceSlug}
      />
    </section>
  )
}

/** RoleDeleteDialog confirms deletion and reports references that prevent it. */
export function RoleDeleteDialog({
  name,
  onOpenChange,
  open,
  orgSlug,
  roleId,
  workspaceSlug,
}: {
  name: string
  onOpenChange: (open: boolean) => void
  open: boolean
  orgSlug: string
  roleId: string
  workspaceSlug?: string
}) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState<DeleteRoleFormState, FormData>(
    async (state, formData) => {
      const result = workspaceSlug
        ? await deleteWorkspaceRoleAction(orgSlug, workspaceSlug, roleId, state, formData)
        : await deleteOrganizationRoleAction(orgSlug, roleId, state, formData)
      if (result.href) {
        toast.success("Role deleted")
        router.push(result.href)
      }
      return result
    },
    {}
  )

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            Deleting this Role removes all of its Permission Grants. You cannot undo this action.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          {state.error ? (
            <Alert variant="destructive">
              <Trash2 aria-hidden="true" />
              <AlertTitle>Role not deleted</AlertTitle>
              <AlertDescription>
                {state.error}
                {state.references?.length ? (
                  <span className="mt-2 block">{state.references.join(" · ")}</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="mx-0 -mr-4 mb-0 -ml-4">
            <DialogClose asChild>
              <Button disabled={pending} type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button data-dialog-submit disabled={pending} type="submit" variant="destructive">
              {pending ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
              {pending ? "Deleting..." : "Delete role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
