"use client"

import { useActionState } from "react"
import { Trash2 } from "lucide-react"
import { deleteTeamAction, type DeleteTeamFormState } from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
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

export function TeamDelete({
  name,
  orgSlug,
  teamId,
}: {
  name: string
  orgSlug: string
  teamId: string
}) {
  const action = deleteTeamAction.bind(null, orgSlug, teamId)
  const [state, formAction, pending] = useActionState<DeleteTeamFormState, FormData>(action, {})

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete Team</CardTitle>
        <CardDescription>
          Members immediately lose access inherited only through this Team. Direct Role assignments
          remain.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 />
              Delete Team
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {name}?</DialogTitle>
              <DialogDescription>
                This removes the Team and its shared Role assignments. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <form action={formAction} className="flex flex-col gap-4">
              {state.error ? (
                <Alert variant="destructive">
                  <Trash2 aria-hidden="true" />
                  <AlertTitle>Team not deleted</AlertTitle>
                  <AlertDescription>{state.error}</AlertDescription>
                </Alert>
              ) : null}
              <DialogFooter className="mx-0 -mr-4 mb-0 -ml-4">
                <DialogClose asChild>
                  <Button disabled={pending} type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button data-dialog-submit disabled={pending} type="submit" variant="destructive">
                  {pending ? <Spinner /> : <Trash2 aria-hidden="true" />}
                  {pending ? "Deleting…" : "Delete Team"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
