"use client"

import Image from "next/image"
import Link from "next/link"
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { authClient } from "@/lib/auth-client"
import { authErrorMessages } from "@/app/(auth)/shared"
import type { SocialProvider } from "@/app/(auth)/shared"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { passwordFieldDescription, passwordSchema } from "@/lib/password-policy"
import { SocialAuthButtons } from "./social-auth-buttons"

const signUpSchema = z
  .object({
    email: z.email("Enter a valid email address."),
    name: z.string().trim().min(1, "Enter your name."),
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm your password."),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })

type SignUpValues = z.infer<typeof signUpSchema>

type SignUpFormProps = {
  actions: Record<SocialProvider, (formData: FormData) => Promise<void>>
  providers: SocialProvider[]
  returnTo?: string
}

const genericSignUpError = "Sign-up could not be completed. Try again."
const emailInUseMessage = authErrorMessages.user_exists
const emailPasswordNotAllowedMessage = authErrorMessages.email_password_auth_not_allowed
const emailPasswordNotAllowedCode = "EMAIL_PASSWORD_AUTH_NOT_ALLOWED"
const userExistsCode = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"

export function SignUpForm({ actions, providers, returnTo }: SignUpFormProps) {
  const [, startTransition] = React.useTransition()
  const [pendingAction, setPendingAction] = React.useState<"password" | SocialProvider>()
  const { clearErrors, control, formState, handleSubmit, setError } = useForm<SignUpValues>({
    criteriaMode: "all",
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      confirmPassword: "",
      email: "",
      name: "",
      password: "",
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
  })

  function submit(values: SignUpValues) {
    setPendingAction("password")
    clearErrors("root")
    startTransition(async () => {
      const result = await authClient.signUp.email({
        callbackURL: returnTo ?? "/",
        email: values.email,
        name: values.name,
        password: values.password,
      })

      if (result.error) {
        if (
          result.error.code === userExistsCode ||
          result.error.code === emailPasswordNotAllowedCode
        ) {
          setPendingAction(undefined)
          setError("email", {
            type: "server",
            message:
              result.error.code === userExistsCode
                ? emailInUseMessage
                : emailPasswordNotAllowedMessage,
          })
          return
        }

        setError("root.server", {
          type: "server",
          message: result.error.message ?? genericSignUpError,
        })
        setPendingAction(undefined)
        return
      }

      window.location.replace(returnTo ?? "/")
    })
  }

  const pendingProvider =
    pendingAction === "github" || pendingAction === "google" ? pendingAction : undefined
  const locked = pendingAction !== undefined
  const rootError = formState.errors.root?.server?.message

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8">
      <div className="flex items-center justify-center gap-3">
        <Image src="/emblem.svg" alt="AccuKnox emblem" width={40} height={40} className="size-10" />
        <span className="text-foreground text-3xl font-semibold tracking-tight">AccuKnox</span>
      </div>
      <form className="flex flex-col gap-5" onSubmit={handleSubmit(submit)} noValidate>
        <FieldGroup>
          <Controller
            name="name"
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="signup-name" required>
                  Name
                </FieldLabel>
                <Input
                  {...field}
                  id="signup-name"
                  autoComplete="name"
                  aria-invalid={fieldState.invalid}
                  disabled={locked}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="email"
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="signup-email" required>
                  Email
                </FieldLabel>
                <Input
                  {...field}
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  suppressHydrationWarning
                  aria-invalid={fieldState.invalid}
                  disabled={locked}
                  onBlur={() => {
                    if (fieldState.error?.type === "server") {
                      clearErrors("email")
                    }
                    field.onBlur()
                  }}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Controller
            name="password"
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="signup-password" required>
                  Password
                </FieldLabel>
                <Input
                  {...field}
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  suppressHydrationWarning
                  aria-invalid={fieldState.invalid}
                  disabled={locked}
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
                <FieldLabel htmlFor="signup-confirm-password" required>
                  Confirm password
                </FieldLabel>
                <Input
                  {...field}
                  id="signup-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  suppressHydrationWarning
                  aria-invalid={fieldState.invalid}
                  disabled={locked}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </FieldGroup>
        {rootError ? <FieldError>{rootError}</FieldError> : null}
        <Button type="submit" size="lg" disabled={locked}>
          {pendingAction === "password" ? <Spinner data-icon="inline-start" /> : null}
          Sign up
        </Button>
      </form>
      {providers.length > 0 ? (
        <div className="flex flex-col gap-5">
          <FieldSeparator>or</FieldSeparator>
          <SocialAuthButtons
            actions={actions}
            disabled={locked}
            providers={providers}
            returnTo={returnTo}
            submitLabel="Sign up"
            pendingProvider={pendingProvider}
            onPendingChangeAction={setPendingAction}
          />
        </div>
      ) : null}
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{" "}
        <Link className="text-foreground underline underline-offset-4" href="/signin">
          Sign in
        </Link>
      </p>
    </div>
  )
}
