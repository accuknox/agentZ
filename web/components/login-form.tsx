"use client"

import { useTransition } from "react"
import { GitHubDark } from "@ridemountainpig/svgl-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"

const errorMessages = {
  invalid_code: "GitHub sign-in could not be completed. Try again.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the login page.",
  state_mismatch: "The sign-in session expired or was opened in another tab. Try again.",
  unable_to_get_user_info:
    "GitHub sign-in failed or this account is not authorized for this application.",
} as const satisfies Record<string, string>

export function LoginForm({
  error,
  ...props
}: React.ComponentProps<typeof Card> & { error?: string }) {
  const [pending, startTransition] = useTransition()
  const message = error ? errorMessages[error as keyof typeof errorMessages] : null

  function signInWithGithub() {
    startTransition(async () => {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: "/",
        errorCallbackURL: "/login",
      })
    })
  }

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>Login to your account</CardTitle>
      </CardHeader>
      <CardContent>
        <form>
          <FieldGroup>
            <Field>
              <Button type="button" variant="outline" disabled={pending} onClick={signInWithGithub}>
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <GitHubDark data-icon="inline-start" />
                )}
                Continue with GitHub
              </Button>
              {message ? <FieldDescription>{message}</FieldDescription> : null}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
