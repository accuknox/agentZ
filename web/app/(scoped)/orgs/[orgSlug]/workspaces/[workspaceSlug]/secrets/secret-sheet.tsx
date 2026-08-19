"use client"

import * as React from "react"
import { toast } from "sonner"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { KeyRound } from "lucide-react"
import type { PutSecretFormAction, PutSecretFormState } from "@/data/types"
import { secretFormInputSchema } from "@/data/schema"
import type * as z from "zod"
import { Alert, AlertDescription } from "@/components/ui/alert"
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

type SecretFormInput = z.input<typeof secretFormInputSchema>
type SecretFormValues = z.output<typeof secretFormInputSchema>

const defaultFormValues: SecretFormInput = {
  key: "",
  value: "",
  hosts: "",
}

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
  const [state, action, isPending] = React.useActionState(
    async (state: PutSecretFormState, formData: FormData) => {
      const result = await putSecretAction(agentName, state, formData)
      if (result.success) {
        toast.success("Secret created")
        onOpenChangeAction(false)
      }
      return result
    },
    {}
  )
  const {
    clearErrors,
    control,
    formState: { errors },
    handleSubmit,
    register,
    reset,
    setError,
  } = useForm<SecretFormInput, undefined, SecretFormValues>({
    resolver: zodResolver(secretFormInputSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: defaultFormValues,
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

  function submitAction(values: SecretFormValues) {
    const formData = new FormData()
    formData.set("key", values.key)
    formData.set("value", values.value)
    formData.set("hosts", values.hosts.join("\n"))

    React.startTransition(() => {
      action(formData)
    })
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    clearErrors()
    void handleSubmit(submitAction)()
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
          reset(defaultFormValues)
          clearErrors()
        }
        onOpenChangeAction(nextOpen)
      }}
    >
      <SheetContent className="h-full overflow-y-auto sm:w-[50vw]! sm:max-w-none!">
        <SheetHeader className="shrink-0">
          <SheetTitle>New secret</SheetTitle>
          <SheetDescription>
            Create a static secret. Its value becomes write-only after you save it.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex flex-1 flex-col gap-4 p-4">
          <FieldGroup>
            <Field data-invalid={Boolean(errors.key)}>
              <FieldLabel htmlFor="secret-key" required>
                Name
              </FieldLabel>
              <Input
                id="secret-key"
                placeholder="SECRET_NAME"
                aria-invalid={Boolean(errors.key)}
                aria-required="true"
                {...register("key")}
              />
              {errors.key ? <FieldError errors={[errors.key]} /> : null}
            </Field>
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
            <Field data-invalid={Boolean(errors.value)}>
              <FieldLabel htmlFor="secret-value" required>
                Value
              </FieldLabel>
              <Textarea
                id="secret-value"
                placeholder="Enter secret value..."
                className="min-h-32 resize-y font-mono"
                aria-invalid={Boolean(errors.value)}
                aria-required="true"
                {...register("value")}
              />
              {errors.value ? <FieldError errors={[errors.value]} /> : null}
            </Field>
          </FieldGroup>
          {generalErrorMessage ? (
            <Alert
              className="-mx-4 w-[calc(100%+2rem)] max-w-none shrink-0 px-4"
              variant="destructive"
            >
              <AlertDescription>{generalErrorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <div className="shrink-0">
            <Button type="submit" disabled={isPending} className="w-full">
              {isPending ? <Spinner /> : <KeyRound data-icon="inline-start" />}
              {isPending ? "Creating…" : "Create secret"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
