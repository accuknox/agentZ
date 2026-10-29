"use client"

import { useState, useTransition } from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Save } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import type { GuardrailAssignment } from "@/lib/gateway/client"
import {
  loadExternalAgentGuardrailsAction,
  saveExternalAgentGuardrailsAction,
} from "@/data/guardrail.actions"
import { SubjectGuardrails } from "@/components/guardrails/subject-guardrails"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { LoadingButton } from "@/components/interior/loading-button"
import { FieldError } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

type ExternalAgentGuardrailData = NonNullable<
  Awaited<ReturnType<typeof loadExternalAgentGuardrailsAction>>["data"]
>

type ExternalAgentGuardrailsPanelProps = {
  orgSlug: string
  workspaceSlug: string
  clientId: string
}

export function ExternalAgentGuardrailsPanel(props: ExternalAgentGuardrailsPanelProps) {
  const { orgSlug, workspaceSlug, clientId } = props

  const { data: actor } = authClient.useSession()
  const query = useQuery(
    queryOptions({
      queryKey: ["externalAgentGuardrails", actor?.user.id, orgSlug, workspaceSlug, clientId],
      enabled: actor?.user.id !== undefined,
      queryFn: async () => {
        const result = await loadExternalAgentGuardrailsAction(orgSlug, workspaceSlug, clientId)
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
    <ExternalAgentGuardrailsForm
      {...props}
      data={query.data}
      key={`${clientId}/${query.data.updatedAt ?? "new"}`}
      onSaved={() => void query.refetch()}
    />
  )
}

type ExternalAgentGuardrailsFormProps = ExternalAgentGuardrailsPanelProps & {
  data: ExternalAgentGuardrailData
  onSaved: () => void
}

function ExternalAgentGuardrailsForm(props: ExternalAgentGuardrailsFormProps) {
  const { data, orgSlug, workspaceSlug, clientId, onSaved } = props

  const [assignment, setAssignment] = useState<GuardrailAssignment>(data.assignment)
  const [error, setError] = useState("")
  const [pending, startTransition] = useTransition()
  return (
    <form
      className="flex min-w-0 flex-col gap-6 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        startTransition(async () => {
          const result = await saveExternalAgentGuardrailsAction(
            orgSlug,
            workspaceSlug,
            clientId,
            assignment
          )
          if (result.error) {
            setError(result.error)
            return
          }
          toast.success("Guardrails saved. Changes will apply automatically.")
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
