"use client"

import { useActionState } from "react"
import { CircleAlert, Save } from "lucide-react"
import { toast } from "sonner"
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
  const [state, formAction, pending] = useActionState<UpdateWorkspaceFormState, FormData>(
    async (state, formData) => {
      const result = await updateWorkspaceAction(orgSlug, workspaceId, state, formData)
      if (result.saved) toast.success("Workspace updated")
      return result
    },
    {}
  )

  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-5 px-4 md:px-6">
      {state.error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Workspace not updated</AlertTitle>
          <AlertDescription>{state.error}</AlertDescription>
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
      <div className="flex justify-end">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner aria-hidden="true" /> : <Save data-icon="inline-start" />}
          {pending ? "Updating..." : "Update Workspace"}
        </Button>
      </div>
    </form>
  )
}
