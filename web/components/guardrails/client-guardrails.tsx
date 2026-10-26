"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Save } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import type { GuardrailAssignment } from "@/lib/gateway/client"
import {
  loadClientGuardrailsAction,
  saveGuardrailClientAccessAction,
} from "@/data/guardrail.actions"
import { SubjectGuardrails } from "@/components/guardrails/subject-guardrails"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { LoadingButton } from "@/components/interior/loading-button"
import { FieldError } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

type ClientGuardrailData = NonNullable<
  Awaited<ReturnType<typeof loadClientGuardrailsAction>>["data"]
>

type ClientGuardrailsPanelProps = {
  orgSlug: string
  workspaceSlug: string
  clientId: string
}

export function ClientGuardrailsPanel(props: ClientGuardrailsPanelProps) {
  const { orgSlug, workspaceSlug, clientId } = props

  const { data: actor } = authClient.useSession()
  const query = useQuery(
    queryOptions({
      queryKey: ["clientGuardrails", actor?.user.id, orgSlug, workspaceSlug, clientId],
      enabled: actor?.user.id !== undefined,
      queryFn: async () => {
        const result = await loadClientGuardrailsAction(orgSlug, workspaceSlug, clientId)
        if (result.error || !result.data)
          throw new Error(result.error ?? "Could not load guardrails.")
        return result.data
      },
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })
  )
  if (query.isPending)
    return (
      <div className="flex flex-col gap-4 p-4" role="status">
        <span className="sr-only">Loading protection settings</span>
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    )
  if (query.error)
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertTitle>Guardrail settings unavailable</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      </div>
    )
  return (
    <ClientGuardrailsForm
      data={query.data}
      key={`${clientId}/${query.data.subject.updatedAt ?? "new"}`}
      onSaved={() => void query.refetch()}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  )
}

type ClientGuardrailsFormProps = {
  data: ClientGuardrailData
  orgSlug: string
  workspaceSlug: string
  onSaved: () => void
}

function ClientGuardrailsForm(props: ClientGuardrailsFormProps) {
  const { data, orgSlug, workspaceSlug, onSaved } = props

  const router = useRouter()
  const [assignment, setAssignment] = useState<GuardrailAssignment>(data.subject.guardrails)
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()
  return (
    <form
      className="flex min-w-0 flex-col gap-6 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        startTransition(async () => {
          const result = await saveGuardrailClientAccessAction(
            orgSlug,
            workspaceSlug,
            data.subject.clientId,
            assignment
          )
          if (result.error) {
            setError(result.error)
            return
          }
          toast.success("Guardrails saved. Changes apply after rollout.")
          router.refresh()
          onSaved()
        })
      }}
    >
      <SubjectGuardrails
        assignment={assignment}
        disabled={pending}
        onChange={setAssignment}
        policies={data.policies}
        settings={data.settings}
      />
      {error ? <FieldError>{error}</FieldError> : null}
      <Separator className="-mx-4 w-[calc(100%+2rem)]" />
      <div className="flex justify-end">
        <LoadingButton pending={pending} pendingLabel="Saving..." type="submit">
          <Save data-icon="inline-start" />
          Save guardrails
        </LoadingButton>
      </div>
    </form>
  )
}
