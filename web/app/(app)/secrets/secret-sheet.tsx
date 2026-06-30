"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import type { PutSecretFormAction } from "@/data/types"
import { secretFormInputSchema } from "@/data/schema"
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
import { SecretHostsField } from "./secret-hosts-field"

type SecretFormValues = z.input<typeof secretFormInputSchema>

export function SecretSheet({
  agentName,
  putSecretAction,
  open,
  onOpenChangeAction,
}: {
  agentName: string
  putSecretAction: PutSecretFormAction
  open: boolean
  onOpenChangeAction: (open: boolean) => void
}) {
  const [state, action, isPending] = React.useActionState(putSecretAction.bind(null, agentName), {})
  const { control, reset, setError, trigger } = useForm<SecretFormValues>({
    resolver: zodResolver(secretFormInputSchema),
    defaultValues: {
      key: "",
      value: "",
      hosts: "",
    },
  })

  React.useEffect(() => {
    if (state.error?.errors) {
      for (const err of state.error.errors) {
        if (err.field === "key" || err.field === "value" || err.field === "hosts") {
          setError(err.field, { type: "server", message: err.message })
        }
      }
    }
  }, [setError, state.error])

  async function submitAction(formData: FormData) {
    const isValid = await trigger()
    if (!isValid) {
      return
    }

    React.startTransition(() => {
      action(formData)
    })
  }

  const generalErrorMessage = (() => {
    if (!state.error) {
      return undefined
    }

    const fieldErrors =
      state.error.errors?.filter(
        (error) => error.field === "key" || error.field === "value" || error.field === "hosts"
      ) ?? []
    const hasGeneralError = !state.error.errors || state.error.errors.length > fieldErrors.length

    return hasGeneralError ? state.error.message : undefined
  })()

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          reset()
        }
        onOpenChangeAction(nextOpen)
      }}
    >
      <SheetContent className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle>New secret</SheetTitle>
          <SheetDescription>Create a static secret. Values cannot be read later.</SheetDescription>
        </SheetHeader>
        <form action={submitAction} className="flex flex-1 flex-col gap-4 p-4">
          <FieldGroup>
            <Controller
              name="key"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="secret-key" required>
                    Name
                  </FieldLabel>
                  <Input
                    id="secret-key"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="SECRET_NAME"
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
            <Controller
              name="hosts"
              control={control}
              render={({ field, fieldState }) => (
                <SecretHostsField
                  name={field.name}
                  value={field.value}
                  inputRef={field.ref}
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  inputID="secret-hosts"
                />
              )}
            />
            <Controller
              name="value"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="secret-value" required>
                    Value
                  </FieldLabel>
                  <Textarea
                    id="secret-value"
                    name={field.name}
                    ref={field.ref}
                    value={field.value}
                    onBlur={field.onBlur}
                    onChange={field.onChange}
                    placeholder="Enter secret value..."
                    className="min-h-32 resize-y font-mono"
                    aria-invalid={fieldState.invalid}
                    aria-required="true"
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldGroup>
          {generalErrorMessage ? (
            <p className="border-destructive/30 bg-destructive/5 text-destructive shrink-0 rounded-md border p-3 text-sm">
              {generalErrorMessage}
            </p>
          ) : null}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending} className="w-full">
              {isPending ? <Spinner /> : null}
              {isPending ? "Creating..." : "Create secret"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
