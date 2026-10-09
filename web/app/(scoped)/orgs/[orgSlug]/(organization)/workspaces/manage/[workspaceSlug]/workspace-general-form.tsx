"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { CircleAlert, Save } from "lucide-react"
import { toast } from "sonner"
import { updateWorkspaceAction } from "@/app/(scoped)/orgs/actions"
import { workspaceNameSchema } from "@/data/schema"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

const workspaceFormSchema = z.object({ name: workspaceNameSchema })

export function WorkspaceGeneralForm({
  name,
  orgSlug,
  workspaceId,
}: {
  name: string
  orgSlug: string
  workspaceId: string
}) {
  const form = useForm<z.infer<typeof workspaceFormSchema>>({
    defaultValues: { name },
    resolver: zodResolver(workspaceFormSchema),
  })
  const pending = form.formState.isSubmitting
  const error = form.formState.errors.root?.message
  const submit = form.handleSubmit(async (values) => {
    form.clearErrors("root")
    const data = new FormData()
    data.set("name", values.name)
    const result = await updateWorkspaceAction(orgSlug, workspaceId, {}, data)
    if (result.error) {
      form.setError("root", { message: result.error })
      return
    }
    if (result.saved) toast.success("Workspace updated")
  })
  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-5 px-4 md:px-6">
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Workspace not updated</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="workspace-name" required>
                Name
              </FieldLabel>
              <Input
                {...field}
                autoComplete="off"
                id="workspace-name"
                maxLength={100}
                required
                disabled={pending}
                aria-invalid={fieldState.invalid}
                aria-describedby={fieldState.invalid ? "workspace-name-error" : undefined}
              />
              <FieldError id="workspace-name-error" errors={[fieldState.error]} />
            </Field>
          )}
        />
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
