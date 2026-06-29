"use client"

import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { SocialProvider } from "@/app/(auth)/shared"

type SocialAuthButtonsProps = {
  disabled?: boolean
  pendingProvider?: SocialProvider
  providers: SocialProvider[]
  returnTo?: string
  submitLabel: "Sign in" | "Sign up"
  onPendingChangeAction?: (provider: SocialProvider) => void
  actions: Record<SocialProvider, (formData: FormData) => Promise<void>>
}

export function SocialAuthButtons({
  actions,
  disabled = false,
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
          onSubmitCapture={() => {
            onPendingChangeAction?.(provider)
          }}
        >
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <Button
            type="submit"
            variant="outline"
            size="lg"
            className="w-full gap-3"
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
        </form>
      ))}
    </div>
  )
}
