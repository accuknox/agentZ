"use client"

import { useActionState } from "react"
import { CircleAlert, CircleCheck } from "lucide-react"
import { updateWorkspaceAction, type UpdateWorkspaceFormState } from "@/app/(scoped)/orgs/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function WorkspaceGeneralForm({
  name,
  orgSlug,
  workspaceId,
}: {
  name: string
  orgSlug: string
  workspaceId: string
}) {
  const action = updateWorkspaceAction.bind(null, orgSlug, workspaceId)
  const [state, formAction, pending] = useActionState<UpdateWorkspaceFormState, FormData>(
    action,
    {}
  )

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5 px-4 md:px-6">
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Workspace not saved</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.saved ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Workspace saved</AlertTitle>
        </Alert>
      ) : null}
      <FieldGroup>
        <Field data-invalid={Boolean(state.error)}>
          <FieldLabel htmlFor="workspace-name" required>
            Name
          </FieldLabel>
          <Input
            autoComplete="off"
            defaultValue={name}
            id="workspace-name"
            maxLength={100}
            name="name"
            required
          />
          {state.error ? <FieldError>{state.error}</FieldError> : null}
        </Field>
      </FieldGroup>
      <div>
        <Button disabled={pending} type="submit">
          {pending ? <Spinner aria-hidden="true" /> : null}
          {pending ? "Saving…" : "Save Workspace"}
        </Button>
      </div>
    </form>
  )
}
