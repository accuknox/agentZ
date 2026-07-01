"use client"

import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import type { AuthPath, SocialProvider } from "@/app/(auth)/shared"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"

type SocialAuthButtonsProps = {
  authPath: AuthPath
  disabled?: boolean
  errors?: Partial<Record<SocialProvider, string>>
  pendingProvider?: SocialProvider
  providers: SocialProvider[]
  returnTo?: string
  submitLabel: "Sign in" | "Sign up"
  onPendingChangeAction?: (provider: SocialProvider) => void
  actions: Record<SocialProvider, (formData: FormData) => Promise<void>>
}

export function SocialAuthButtons({
  actions,
  authPath,
  disabled = false,
  errors,
  onPendingChangeAction,
  pendingProvider,
  providers,
  returnTo,
  submitLabel,
}: SocialAuthButtonsProps) {
  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => (
        <form
          key={provider}
          action={actions[provider]}
          className="flex flex-col gap-2"
          onSubmitCapture={() => {
            onPendingChangeAction?.(provider)
          }}
        >
          <input type="hidden" name="authPath" value={authPath} />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <Button
            type="submit"
            variant="outline"
            size="lg"
            className="w-full gap-3"
            aria-invalid={errors?.[provider] ? "true" : undefined}
            disabled={disabled}
          >
            {pendingProvider === provider ? (
              <Spinner data-icon="inline-start" />
            ) : provider === "github" ? (
              <>
                <GitHubLight data-icon="inline-start" className="dark:hidden" />
                <GitHubDark data-icon="inline-start" className="hidden dark:block" />
              </>
            ) : (
              <Google data-icon="inline-start" />
            )}
            {submitLabel} with {provider === "github" ? "GitHub" : "Google"}
          </Button>
          {errors?.[provider] ? (
            <FieldError className="text-center leading-normal">{errors[provider]}</FieldError>
          ) : null}
        </form>
      ))}
    </div>
  )
}
