import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup } from "@/components/ui/field"
import { LoginSubmitButton } from "@/components/login-submit-button"

const errorMessages = {
  invalid_code: "GitHub sign-in could not be completed. Try again.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the login page.",
  state_mismatch: "The sign-in session expired or was opened in another tab. Try again.",
  unable_to_get_user_info:
    "GitHub sign-in failed or this account is not authorized for this application.",
} as const satisfies Record<string, string>

export type LoginError = keyof typeof errorMessages

export function LoginForm({
  action,
  error,
  ...props
}: React.ComponentProps<typeof Card> & {
  action: () => Promise<void>
  error?: LoginError
}) {
  const message = error ? errorMessages[error] : null

  return (
    <Card {...props}>
      <CardHeader>
        <CardTitle>Login to your account</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action}>
          <FieldGroup>
            <Field data-invalid={Boolean(message)}>
              <LoginSubmitButton />
              {message ? <FieldError>{message}</FieldError> : null}
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
