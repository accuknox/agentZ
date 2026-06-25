"use client"

import { useFormStatus } from "react-dom"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export type LoginProvider = "github" | "google"

export function LoginSubmitButton({ provider }: { provider: LoginProvider }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="outline" size="lg" className="w-full gap-3" disabled={pending}>
      {pending ? (
        <Spinner data-icon="inline-start" />
      ) : provider === "github" ? (
        <>
          <GitHubLight data-icon="inline-start" className="dark:hidden" />
          <GitHubDark data-icon="inline-start" className="hidden dark:block" />
        </>
      ) : (
        <Google data-icon="inline-start" />
      )}
      Sign in with {provider === "github" ? "GitHub" : "Google"}
    </Button>
  )
}
