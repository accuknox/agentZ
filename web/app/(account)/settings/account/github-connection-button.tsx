"use client"

import { useFormStatus } from "react-dom"
import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import { Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export function GitHubConnectionButton({
  connected = false,
  disabled = false,
}: {
  connected?: boolean
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  const label = connected ? "Disconnect GitHub" : "Connect GitHub"
  const pendingLabel = connected ? "Disconnecting..." : "Connecting..."

  return (
    <Button disabled={disabled || pending} variant="outline" type="submit">
      {pending ? (
        <Spinner data-icon="inline-start" aria-label={pendingLabel} />
      ) : connected ? (
        <Unplug data-icon="inline-start" aria-hidden="true" />
      ) : (
        <>
          <GitHubLight data-icon="inline-start" className="dark:hidden" aria-hidden="true" />
          <GitHubDark data-icon="inline-start" className="hidden dark:block" aria-hidden="true" />
        </>
      )}
      {pending ? pendingLabel : label}
    </Button>
  )
}
