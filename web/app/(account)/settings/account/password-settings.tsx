"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { KeyRound } from "lucide-react"
import { z } from "zod"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { passwordFieldDescription, passwordSchema } from "@/lib/password-policy"

const changePasswordSchema = z
  .object({
    confirmPassword: z
      .string({ error: "Confirm your new password." })
      .min(1, "Confirm your new password."),
    currentPassword: z
      .string({ error: "Enter your current password." })
      .min(1, "Enter your current password."),
    newPassword: passwordSchema,
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })

type ChangePasswordValues = z.infer<typeof changePasswordSchema>

const currentPasswordError = "Current password is incorrect."
const genericChangePasswordError = "Password could not be changed. Try again."

export function PasswordSettings() {
  const [, startTransition] = React.useTransition()
  const [pendingAction, setPendingAction] = React.useState(false)
  const [success, setSuccess] = React.useState(false)
  const { clearErrors, control, formState, handleSubmit, reset, setError } =
    useForm<ChangePasswordValues>({
      criteriaMode: "all",
      resolver: zodResolver(changePasswordSchema),
      defaultValues: {
        confirmPassword: "",
        currentPassword: "",
        newPassword: "",
      },
      mode: "onSubmit",
      reValidateMode: "onBlur",
    })

  function submit(values: ChangePasswordValues) {
    setPendingAction(true)
    clearErrors("root")
    setSuccess(false)
    startTransition(async () => {
      const result = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      })

      if (result.error) {
        if (result.error.status === 400 || result.error.status === 401) {
          setPendingAction(false)
          setError("currentPassword", {
            type: "server",
            message: currentPasswordError,
          })
          return
        }

        setError("root.server", {
          type: "server",
          message: result.error.message ?? genericChangePasswordError,
        })
        setPendingAction(false)
        return
      }

      setPendingAction(false)
      setSuccess(true)
      reset()
    })
  }

  const rootError = formState.errors.root?.server?.message

  return (
    <section className="flex flex-col gap-4 px-4 md:px-6">
      <h2 className="text-lg font-semibold tracking-normal">Password</h2>
      <div className="w-full max-w-2xl">
        <form
          className="flex flex-col gap-5"
          method="post"
          onSubmit={handleSubmit(submit)}
          noValidate
        >
          <FieldGroup>
            <Controller
              name="currentPassword"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="account-current-password" required>
                    Current password
                  </FieldLabel>
                  <Input
                    {...field}
                    id="account-current-password"
                    type="password"
                    autoComplete="current-password"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid}
                    disabled={pendingAction}
                    onBlur={() => {
                      if (fieldState.error?.type === "server") {
                        clearErrors("currentPassword")
                      }
                      field.onBlur()
                    }}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="newPassword"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="account-new-password" required>
                    New password
                  </FieldLabel>
                  <Input
                    {...field}
                    id="account-new-password"
                    type="password"
                    autoComplete="new-password"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid}
                    disabled={pendingAction}
                  />
                  <FieldDescription>{passwordFieldDescription}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              name="confirmPassword"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="account-confirm-password" required>
                    Confirm new password
                  </FieldLabel>
                  <Input
                    {...field}
                    id="account-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid}
                    disabled={pendingAction}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          {rootError ? <FieldError>{rootError}</FieldError> : null}
          {success ? <p className="text-sm">Password updated.</p> : null}
          <div>
            <Button type="submit" disabled={pendingAction}>
              {pendingAction ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              Update password
            </Button>
          </div>
        </form>
      </div>
    </section>
  )
}
