"use client"

import { useActionState } from "react"
import { Trash2 } from "lucide-react"
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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export function RoleDelete({
  name,
  orgSlug,
  roleId,
  workspaceSlug,
}: {
  name: string
  orgSlug: string
  roleId: string
  workspaceSlug?: string
}) {
  const action = workspaceSlug
    ? deleteWorkspaceRoleAction.bind(null, orgSlug, workspaceSlug, roleId)
    : deleteOrganizationRoleAction.bind(null, orgSlug, roleId)
  const [state, formAction, pending] = useActionState<DeleteRoleFormState, FormData>(action, {})

  return (
    <section className="grid gap-3 px-4 pb-6 md:px-6">
      <h2 className="text-lg font-medium">Delete role</h2>
      <div>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 />
              Delete role
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {name}?</DialogTitle>
              <DialogDescription>
                This removes the reusable Role and all of its Permission Grants. This cannot be
                undone.
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
                  {pending ? <Spinner /> : <Trash2 />}
                  {pending ? "Deleting…" : "Delete role"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  )
}
