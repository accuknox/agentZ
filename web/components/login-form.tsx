import Image from "next/image"
import { Field, FieldError, FieldGroup } from "@/components/ui/field"
import { LoginSubmitButton } from "@/components/login-submit-button"

const errorMessages = {
  invalid_code: "GitHub sign-in could not be completed. Try again.",
  no_callback_url: "Sign-in was started incorrectly. Retry from the login page.",
  session_expired: "Your session expired. Sign in again to continue.",
  state_mismatch: "The sign-in session expired or was opened in another tab. Try again.",
  unable_to_get_user_info:
    "GitHub sign-in failed or this account is not authorized for this application.",
} as const satisfies Record<string, string>

export type LoginError = keyof typeof errorMessages

type LoginFormProps = {
  action: (formData: FormData) => Promise<void>
  error?: LoginError
  returnTo?: string
}

export function LoginForm({ action, error, returnTo }: LoginFormProps) {
  const message = error ? errorMessages[error] : null

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-8 pt-10">
      <div className="flex items-center justify-center gap-3">
        <Image src="/emblem.svg" alt="AccuKnox emblem" width={40} height={40} className="size-10" />
        <span className="text-foreground text-3xl font-semibold tracking-tight">AccuKnox</span>
      </div>

      <form action={action}>
        {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
        <FieldGroup>
          <Field data-invalid={Boolean(message)}>
            <LoginSubmitButton />
            {message ? <FieldError>{message}</FieldError> : null}
          </Field>
        </FieldGroup>
      </form>
    </div>
  )
}
