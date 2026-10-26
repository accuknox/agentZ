import { Suspense } from "react"
import { connection } from "next/server"
import {
  AdministrationLoadingState,
  AdministrationPageHeader,
  AdministrationState,
} from "@/components/administration"
import { listGuardrailClientAccess } from "@/data/guardrail-client-access"
import { RememberRoute } from "@/data/route-memory"
import { ApplicationGuardrailAccess } from "./applications"

export const metadata = { title: "Application access guardrails" }

export default function ApplicationAccessPage(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/applications/access">
) {
  return (
    <Suspense fallback={<AdministrationLoadingState />}>
      <ApplicationAccessContent {...props} />
    </Suspense>
  )
}

async function ApplicationAccessContent(
  props: PageProps<"/orgs/[orgSlug]/workspaces/[workspaceSlug]/applications/access">
) {
  const { params } = props

  await connection()
  const { orgSlug, workspaceSlug } = await params
  const result = await listGuardrailClientAccess(orgSlug, workspaceSlug)
  if (!result) return <AdministrationState kind="forbidden" />
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <RememberRoute />
      <AdministrationPageHeader
        scope={{
          kind: "workspace",
          organizationName: result.organization.name,
          workspaceName: result.workspace.name,
        }}
        title="Application access"
      />
      <ApplicationGuardrailAccess
        clients={result.clients}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </main>
  )
}
