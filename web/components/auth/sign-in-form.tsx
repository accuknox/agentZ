"use client"

import Image from "next/image"
import Link from "next/link"
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { LogIn } from "lucide-react"
import { z } from "zod"
import type { AuthError, SocialProvider } from "@/app/(auth)/shared"
import { authErrorMessages } from "@/app/(auth)/shared"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SocialAuthButtons } from "./social-auth-buttons"

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
  showPasswordAuth?: boolean
  showSignUpLink?: boolean
}

const invalidCredentialsMessage = authErrorMessages.invalid_email_or_password
const genericSignInError = "Sign-in could not be completed. Try again."
const emailNotVerifiedMessage = "Your email is not verified."
const emailPasswordDisabledMessage = "Email/password sign-in is not available."

export function SignInForm({
  actions,
  providers,
  returnTo,
  routeError,
  routeProvider,
  showPasswordAuth = true,
  showSignUpLink = true,
}: SignInFormProps) {
  const [, startTransition] = React.useTransition()
  const [pendingAction, setPendingAction] = React.useState<"password" | SocialProvider>()
  const [routeCredentialErrorVisible, setRouteCredentialErrorVisible] = React.useState(
    routeError === "invalid_email_or_password"
  )
  const [passwordActionError, setPasswordActionError] = React.useState<string | undefined>(() => {
    if (!routeError || routeError === "invalid_email_or_password") {
      return
    }

    if (routeProvider && providers.includes(routeProvider)) {
      return
    }

    return authErrorMessages[routeError]
  })
  const [providerErrors, setProviderErrors] = React.useState<
    Partial<Record<SocialProvider, string>>
  >(() => {
    if (!routeError || !routeProvider || !providers.includes(routeProvider)) {
      return {}
    }

    return { [routeProvider]: authErrorMessages[routeError] }
  })
  const { control, clearErrors, formState, handleSubmit, setError } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
  })

  function clearPasswordAction(): void {
    setPasswordActionError(undefined)
    setRouteCredentialErrorVisible(false)
  }

  function clearProviderAction(provider?: SocialProvider): void {
    if (!provider) {
      setProviderErrors({})
      return
    }

    setProviderErrors((current) => {
      if (!current[provider]) {
        return current
      }

      return {
        ...current,
        [provider]: undefined,
      }
    })
  }

  function clearCredentialFieldErrors(): void {
    if (!formState.errors.email && !formState.errors.password && !routeCredentialErrorVisible) {
      return
    }

    clearErrors(["email", "password"])
    setRouteCredentialErrorVisible(false)
  }

  function submit(values: SignInValues): void {
    setPendingAction("password")
    clearPasswordAction()
    clearProviderAction()
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
          setPasswordActionError(emailNotVerifiedMessage)
          return
        }

        if (result.error.code === "EMAIL_PASSWORD_DISABLED") {
          setPasswordActionError(emailPasswordDisabledMessage)
          return
        }

        setPasswordActionError(result.error.message ?? genericSignInError)
        return
      }

      const data = result.data
      if (twoFactorRedirectResponseSchema.safeParse(data).success) {
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

  const pendingProvider =
    pendingAction === "github" || pendingAction === "google" ? pendingAction : undefined
  const locked = pendingAction !== undefined

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8">
      <div className="flex items-center justify-center gap-3">
        <Image
          src="/agentz-logo.svg"
          alt="AgentZ logo"
          width={46}
          height={40}
          className="h-10 w-auto"
        />
        <span className="text-foreground text-3xl font-semibold tracking-tight">AgentZ</span>
      </div>
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
                        clearCredentialFieldErrors()
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
                        clearCredentialFieldErrors()
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
            {passwordActionError ? <FieldError>{passwordActionError}</FieldError> : null}
          </div>
        </form>
      ) : null}
      {providers.length > 0 ? (
        <div className={showPasswordAuth ? "flex flex-col gap-5" : "flex flex-col gap-3"}>
          {showPasswordAuth ? <FieldSeparator>or</FieldSeparator> : null}
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
              clearPasswordAction()
              clearProviderAction(provider)
            }}
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
