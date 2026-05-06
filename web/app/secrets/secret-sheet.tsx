"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { PutSecretFormState } from "@/data/types"
import { secretFormSchema } from "@/data/schema"
import type * as z from "zod"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type SecretFormValues = z.infer<typeof secretFormSchema>

type PutSecretAction = (
  sessionID: string,
  state: PutSecretFormState,
  formData: FormData
) => Promise<PutSecretFormState>

export function SecretSheet({
  sessionID,
  mode,
  secretKey,
  putSecretAction,
  open,
  onOpenChangeAction,
}: {
  sessionID: string
  mode: "create" | "update"
  secretKey?: string
  putSecretAction: PutSecretAction
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}) {
  const [state, action] = React.useActionState(putSecretAction.bind(null, sessionID), {})
  const [isPending, startTransition] = React.useTransition()

  const form = useForm<SecretFormValues>({
    resolver: zodResolver(secretFormSchema),
    defaultValues: {
      key: secretKey ?? "",
      value: "",
    },
  })

  React.useEffect(() => {
    if (!isPending && !state.error) {
      form.reset()
      onOpenChangeAction(false)
    }
  }, [isPending, state.error, onOpenChangeAction, form])

  React.useEffect(() => {
    if (open) {
      form.reset({
        key: secretKey ?? "",
        value: "",
      })
    }
  }, [open, secretKey, form])

  React.useEffect(() => {
    if (state.error?.errors) {
      for (const err of state.error.errors) {
        if (err.field === "key" || err.field === "value") {
          form.setError(err.field, { type: "server", message: err.message })
        }
      }
    }
  }, [state.error, form])

  function onSubmit(data: SecretFormValues) {
    const formData = new FormData()
    formData.append("key", data.key)
    formData.append("value", data.value)
    startTransition(() => action(formData))
  }

  const title = mode === "create" ? "New secret" : "Update secret"
  const description =
    mode === "create"
      ? "Create a new secret for this agent. Secret values cannot be read after creation."
      : `Override the value for "${secretKey}". The previous value will be permanently replaced.`
  const submitLabel = mode === "create" ? "Create secret" : "Update secret"

  return (
    <Sheet open={open} onOpenChange={onOpenChangeAction}>
      <SheetContent className="h-full sm:max-w-sm">
        <SheetHeader className="shrink-0">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
        >
          <FieldGroup className="flex-1 min-h-0">
            <Controller
              name="key"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="secret-key">Name</FieldLabel>
                  <Input
                    id="secret-key"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="SECRET_NAME"
                    readOnly={mode === "update"}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              name="value"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid} className="flex-1 min-h-0">
                  <FieldLabel htmlFor="secret-value">Value</FieldLabel>
                  <Textarea
                    id="secret-value"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="Enter secret value..."
                    className="min-h-0 flex-1 resize-none font-mono"
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
          {(() => {
            if (!state.error) return null
            const fieldErrors =
              state.error.errors?.filter((e) => e.field === "key" || e.field === "value") ?? []
            const hasGeneralError =
              !state.error.errors || state.error.errors.length > fieldErrors.length
            if (!hasGeneralError) return null
            return (
              <p className="shrink-0 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {state.error.message}
              </p>
            )
          })()}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending} className="w-full">
              {isPending ? <Spinner /> : null}
              {isPending ? (mode === "create" ? "Creating..." : "Updating...") : submitLabel}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
