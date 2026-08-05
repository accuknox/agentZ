"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useFormStatus } from "react-dom"
import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Workspace } from "@/lib/gateway/client"
import { retryWorkspaceAction } from "@/app/(scoped)/orgs/actions"

export function WorkspaceState({
  canRetry,
  orgSlug,
  workspace,
}: {
  canRetry: boolean
  orgSlug: string
  workspace: Workspace
}) {
  const router = useRouter()

  useEffect(() => {
    if (workspace.state !== "provisioning") {
      return
    }

    const interval = window.setInterval(() => router.refresh(), 3000)
    return () => window.clearInterval(interval)
  }, [router, workspace.state])

  if (workspace.state === "failed") {
    const retry = retryWorkspaceAction.bind(null, orgSlug, workspace.id)
    return (
      <AdministrationState
        actions={
          canRetry ? (
            <form action={retry}>
              <RetryButton />
            </form>
          ) : undefined
        }
        description={
          workspace.failure_reason ?? "Provisioning failed before the Workspace was ready."
        }
        kind="failed"
        title="Workspace provisioning failed"
      />
    )
  }

  if (workspace.state === "provisioning" || workspace.state === "deleting") {
    return <AdministrationState kind={workspace.state} />
  }

  return null
}

function RetryButton() {
  const { pending } = useFormStatus()

  return (
    <Button disabled={pending} type="submit">
      {pending ? <Spinner /> : null}
      {pending ? "Retrying…" : "Retry provisioning"}
    </Button>
  )
}
