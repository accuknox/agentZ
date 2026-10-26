import { Suspense } from "react"
import { connection } from "next/server"
import { AdministrationLoadingState, AdministrationState } from "@/components/administration"
import { GuardrailsLayout } from "@/app/(app)/guardrails/guardrails-layout"
import { getWorkspaceScope } from "@/data/workspaces"

export const metadata = { title: "Guardrails" }

export default function WorkspaceGuardrailsLayout(
  props: LayoutProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/guardrails">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <WorkspaceGuardrails {...props} />
    </Suspense>
  )
}

async function WorkspaceGuardrails(
  props: LayoutProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/guardrails">
) {
  const { params, children } = props

  await connection()
  const { orgSlug, workspaceSlug } = await params
  const result = await getWorkspaceScope(orgSlug, workspaceSlug)
  if (result.kind !== "ready") return <AdministrationState kind="forbidden" />
  const capabilities = result.workspace.capabilities
  return (
    <GuardrailsLayout
      basePath={`/orgs/${orgSlug}/workspaces/${workspaceSlug}/guardrails`}
      canAdminister={result.scope.organization.superadmin || capabilities.administer}
      connectionCapabilities={capabilities.guardrail_connections}
      eventCapabilities={capabilities.guardrail_events}
      pageScope={{
        kind: "workspace",
        organizationName: result.scope.organization.name,
        workspaceName: result.workspace.name,
      }}
      policyCapabilities={capabilities.guardrail_policies}
      workspaceId={result.workspace.id}
    >
      {children}
    </GuardrailsLayout>
  )
}
