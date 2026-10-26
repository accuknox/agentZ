"use client"

import type { ReactNode } from "react"
import { useSelectedLayoutSegments } from "next/navigation"

// Only the actions follow the child route; the header stays in the parent layout.
type GuardrailHeaderActionsProps = {
  connectionAction: ReactNode
  defaultSection: string
  policyAction: ReactNode
}

export function GuardrailHeaderActions(props: GuardrailHeaderActionsProps) {
  const { connectionAction, defaultSection, policyAction } = props

  const segments = useSelectedLayoutSegments()
  const view = segments[0] ?? defaultSection
  if (view === "connections") return connectionAction
  if (view === "policies") return policyAction
  return null
}
