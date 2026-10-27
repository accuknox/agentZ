import type { ReactNode } from "react"
import type { Route } from "next"
import { AdministrationPageHeader, type AdministrationPageScope } from "@/components/administration"
import { RouteTabs } from "@/components/route-tabs"
import type { ResourceCapabilities } from "@/lib/gateway/client"
import {
  GuardrailHeaderActions,
  NewGuardrailConnectionButton,
  NewGuardrailPolicyButton,
} from "./resource-list"

type GuardrailsLayoutProps = {
  basePath: `/orgs/${string}/guardrails`
  canAdminister: boolean
  children: ReactNode
  connectionCapabilities: ResourceCapabilities
  eventCapabilities: ResourceCapabilities
  pageScope: AdministrationPageScope
  policyCapabilities: ResourceCapabilities
  workspaceId?: string
}

export function GuardrailsLayout(props: GuardrailsLayoutProps) {
  const {
    basePath,
    canAdminister,
    children,
    connectionCapabilities,
    eventCapabilities,
    pageScope,
    policyCapabilities,
    workspaceId,
  } = props

  let defaultSection = "events"
  if (connectionCapabilities.read) defaultSection = "providers"
  if (policyCapabilities.read) defaultSection = "policies"
  const tabs = [
    ...(policyCapabilities.read
      ? [{ label: "Policies", href: `${basePath}/policies` as Route }]
      : []),
    ...(connectionCapabilities.read
      ? [{ label: "Providers", href: `${basePath}/providers` as Route }]
      : []),
    ...(eventCapabilities.read ? [{ label: "Events", href: `${basePath}/events` as Route }] : []),
    ...(!workspaceId && canAdminister && policyCapabilities.read
      ? [{ label: "Settings", href: `${basePath}/settings` as Route }]
      : []),
  ]

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader
        actions={
          <GuardrailHeaderActions
            defaultSection={defaultSection}
            connectionAction={
              connectionCapabilities.create ? (
                <NewGuardrailConnectionButton scope={{ workspaceId }} />
              ) : null
            }
            policyAction={
              policyCapabilities.create ? (
                <NewGuardrailPolicyButton
                  scope={{ workspaceId }}
                  canReadConnections={connectionCapabilities.read}
                  canCreateConnection={connectionCapabilities.create}
                />
              ) : null
            }
          />
        }
        scope={pageScope}
        title="Guardrails"
      />
      <div className="px-4 md:px-6">
        <RouteTabs label="Guardrails" tabs={tabs} />
      </div>
      {children}
    </main>
  )
}
