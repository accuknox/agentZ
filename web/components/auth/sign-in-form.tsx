"use client"

import Image from "next/image"
import Link from "next/link"
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { z } from "zod"
import { authClient } from "@/lib/auth-client"
import type { AuthError, SocialProvider } from "@/app/(auth)/shared"
import { authErrorMessages } from "@/app/(auth)/shared"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SocialAuthButtons } from "./social-auth-buttons"

const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
})

type SignInValues = z.infer<typeof signInSchema>

type SignInFormProps = {
  actions: Record<SocialProvider, (formData: FormData) => Promise<void>>
  error?: AuthError
  providers: SocialProvider[]
  returnTo?: string
  showPasswordAuth?: boolean
  showSignUpLink?: boolean
}

const invalidCredentialsMessage = authErrorMessages.invalid_email_or_password
const genericSignInError = "Sign-in could not be completed. Try again."

export function SignInForm({
  actions,
  error,
  providers,
  returnTo,
  showPasswordAuth = true,
  showSignUpLink = true,
}: SignInFormProps) {
  const [, startTransition] = React.useTransition()
  const [pendingAction, setPendingAction] = React.useState<"password" | SocialProvider>()
  const { control, clearErrors, formState, handleSubmit, setError } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
  })

  React.useEffect(() => {
    if (error === "invalid_email_or_password") {
      clearErrors("root")
      setError("email", {
        type: "server",
        message: invalidCredentialsMessage,
      })
      setError("password", {
        type: "server",
        message: invalidCredentialsMessage,
      })
      return
    }

    if (!error) {
      return
    }

    setError("root.server", {
      type: "server",
      message: authErrorMessages[error],
    })
  }, [clearErrors, error, setError])

  function submit(values: SignInValues) {
    setPendingAction("password")
    clearErrors("root")
    startTransition(async () => {
      const result = await authClient.signIn.email({
        callbackURL: returnTo ?? "/",
        email: values.email,
        password: values.password,
      })

      if (result.error) {
        if (result.error.status === 401) {
          setPendingAction(undefined)
          setError("email", {
            type: "server",
            message: invalidCredentialsMessage,
          })
          setError("password", {
            type: "server",
            message: invalidCredentialsMessage,
          })
          return
        }

        setError("root.server", {
          type: "server",
          message: result.error.message ?? genericSignInError,
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
      {showPasswordAuth ? (
        <form className="flex flex-col gap-5" onSubmit={handleSubmit(submit)} noValidate>
          <FieldGroup>
            <Controller
              name="email"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="signin-email" required>
                    Email
                  </FieldLabel>
                  <Input
                    {...field}
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid}
                    disabled={locked}
                    onBlur={() => {
                      if (fieldState.error?.type === "server") {
                        clearErrors(["email", "password"])
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
                  <FieldLabel htmlFor="signin-password" required>
                    Password
                  </FieldLabel>
                  <Input
                    {...field}
                    id="signin-password"
                    type="password"
                    autoComplete="current-password"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid}
                    disabled={locked}
                    onBlur={() => {
                      if (fieldState.error?.type === "server") {
                        clearErrors(["email", "password"])
                      }
                      field.onBlur()
                    }}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
          {rootError ? <FieldError>{rootError}</FieldError> : null}
          <Button type="submit" size="lg" disabled={locked}>
            {pendingAction === "password" ? <Spinner data-icon="inline-start" /> : null}
            Sign in
          </Button>
        </form>
      ) : null}
      {providers.length > 0 ? (
        <div className={showPasswordAuth ? "flex flex-col gap-5" : "flex flex-col gap-3"}>
          {showPasswordAuth ? <FieldSeparator>or</FieldSeparator> : null}
          <SocialAuthButtons
            actions={actions}
            disabled={locked}
            providers={providers}
            returnTo={returnTo}
            submitLabel="Sign in"
            pendingProvider={pendingProvider}
            onPendingChangeAction={setPendingAction}
          />
        </div>
      ) : null}
      {showSignUpLink ? (
        <p className="text-muted-foreground text-center text-sm">
          Need an account?{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            href={returnTo ? `/signup?returnTo=${encodeURIComponent(returnTo)}` : "/signup"}
          >
            Sign up
          </Link>
        </p>
      ) : null}
    </div>
  )
}
