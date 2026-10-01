"use client"

import Link from "next/link"
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { LogIn, CircleAlert } from "lucide-react"
import { z } from "zod"
import type { AuthError, SocialProvider } from "@/app/(auth)/shared"
import { authErrorMessages } from "@/app/(auth)/shared"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SocialAuthButtons } from "./social-auth-buttons"
import { Alert, AlertDescription } from "@/components/ui/alert"

const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
})

const twoFactorRedirectResponseSchema = z.object({
  twoFactorRedirect: z.literal(true),
})

type SignInValues = z.infer<typeof signInSchema>

type SignInFormProps = {
  actions: Record<SocialProvider, (formData: FormData) => Promise<void>>
  providers: SocialProvider[]
  returnTo?: string
  routeError?: AuthError
  routeProvider?: SocialProvider
  showPasswordAuth: boolean
}

const invalidCredentialsMessage = authErrorMessages.invalid_email_or_password

export function SignInForm({
  actions,
  providers,
  returnTo,
  routeError,
  routeProvider,
  showPasswordAuth,
}: SignInFormProps) {
  const [, startTransition] = React.useTransition()
  const [pendingAction, setPendingAction] = React.useState<"password" | SocialProvider>()
  const [passwordActionError, setPasswordActionError] = React.useState<string>()
  const [routeErrorVisible, setRouteErrorVisible] = React.useState(true)
  const { control, clearErrors, handleSubmit, setError } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
  })

  function submit(values: SignInValues): void {
    setPendingAction("password")
    setPasswordActionError(undefined)
    setRouteErrorVisible(false)
    startTransition(async () => {
      const result = await authClient.signIn.email({
        callbackURL: returnTo ?? "/",
        email: values.email,
        password: values.password,
      })

      if (result.error) {
        setPendingAction(undefined)
        if (result.error.status === 401) {
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

        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          setPasswordActionError("Your email is not verified.")
          return
        }

        if (result.error.code === "EMAIL_PASSWORD_DISABLED") {
          setPasswordActionError("Email/password sign-in is not available.")
          return
        }

        setPasswordActionError(result.error.message ?? "Sign-in could not be completed. Try again.")
        return
      }

      if (twoFactorRedirectResponseSchema.safeParse(result.data).success) {
        const search = new URLSearchParams()
        if (returnTo) {
          search.set("returnTo", returnTo)
        }

        const target = search.size === 0 ? "/signin/two-factor" : `/signin/two-factor?${search}`
        window.location.replace(target)
        return
      }

      window.location.replace(returnTo ?? "/")
    })
  }

  const pendingProvider = pendingAction === "password" ? undefined : pendingAction
  const locked = pendingAction !== undefined
  const routeCredentialErrorVisible =
    routeErrorVisible && showPasswordAuth && routeError === "invalid_email_or_password"
  const providerErrors =
    routeErrorVisible && routeError && routeProvider && providers.includes(routeProvider)
      ? { [routeProvider]: authErrorMessages[routeError] }
      : undefined
  const pageError =
    routeErrorVisible && routeError && !routeCredentialErrorVisible && !providerErrors
      ? authErrorMessages[routeError]
      : undefined

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome</h1>
        <p className="text-muted-foreground text-sm text-pretty">Sign in to your workspace.</p>
      </div>
      {pageError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{pageError}</AlertDescription>
        </Alert>
      ) : null}
      {showPasswordAuth ? (
        <form
          className="flex flex-col gap-5"
          method="post"
          onSubmit={handleSubmit(submit)}
          noValidate
        >
          <FieldGroup>
            <Controller
              name="email"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || routeCredentialErrorVisible}>
                  <FieldLabel htmlFor="signin-email" required>
                    Email
                  </FieldLabel>
                  <Input
                    {...field}
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid || routeCredentialErrorVisible}
                    disabled={locked}
                    onBlur={() => {
                      if (fieldState.error?.type === "server" || routeCredentialErrorVisible) {
                        clearErrors(["email", "password"])
                        setRouteErrorVisible(false)
                      }
                      field.onBlur()
                    }}
                  />
                  <FieldError errors={[fieldState.error]}>
                    {fieldState.error?.message ??
                      (routeCredentialErrorVisible ? invalidCredentialsMessage : undefined)}
                  </FieldError>
                </Field>
              )}
            />
            <Controller
              name="password"
              control={control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || routeCredentialErrorVisible}>
                  <FieldLabel htmlFor="signin-password" required>
                    Password
                  </FieldLabel>
                  <Input
                    {...field}
                    id="signin-password"
                    type="password"
                    autoComplete="current-password"
                    suppressHydrationWarning
                    aria-invalid={fieldState.invalid || routeCredentialErrorVisible}
                    disabled={locked}
                    onBlur={() => {
                      if (fieldState.error?.type === "server" || routeCredentialErrorVisible) {
                        clearErrors(["email", "password"])
                        setRouteErrorVisible(false)
                      }
                      field.onBlur()
                    }}
                  />
                  <FieldError errors={[fieldState.error]}>
                    {fieldState.error?.message ??
                      (routeCredentialErrorVisible ? invalidCredentialsMessage : undefined)}
                  </FieldError>
                </Field>
              )}
            />
          </FieldGroup>
          <div className="flex flex-col gap-3">
            <Button
              type="submit"
              size="lg"
              aria-invalid={passwordActionError ? "true" : undefined}
              disabled={locked}
            >
              {pendingAction === "password" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <LogIn data-icon="inline-start" />
              )}
              Sign in
            </Button>
            {passwordActionError ? (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>{passwordActionError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </form>
      ) : null}
      {providers.length > 0 ? (
        <div className="flex flex-col gap-5">
          {showPasswordAuth ? <FieldSeparator>or continue with</FieldSeparator> : null}
          <SocialAuthButtons
            actions={actions}
            authPath="/signin"
            disabled={locked}
            errors={providerErrors}
            providers={providers}
            returnTo={returnTo}
            submitLabel="Sign in"
            pendingProvider={pendingProvider}
            onPendingChangeAction={(provider) => {
              setPendingAction(provider)
              setPasswordActionError(undefined)
              setRouteErrorVisible(false)
            }}
          />
        </div>
      ) : null}
      {showPasswordAuth ? (
        <p className="text-muted-foreground text-center text-sm">
          Don&apos;t have an account?{" "}
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
