"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderSheet } from "./provider-sheet"
import type { InferenceProviderActionScope } from "@/data/inference-provider.actions"
import { resourceLabels } from "@/lib/resource-labels"

/** NewInferenceProviderButton opens an empty provider sheet. */
export function NewInferenceProviderButton({ scope }: { scope: InferenceProviderActionScope }) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {resourceLabels.inference.action}
      </Button>
      <ProviderSheet
        key={open ? "new" : "closed"}
        open={open}
        onOpenChange={setOpen}
        scope={scope}
      />
    </>
  )
}
