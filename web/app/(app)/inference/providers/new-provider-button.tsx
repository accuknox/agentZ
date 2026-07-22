"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderSheet } from "./provider-sheet"

/** NewInferenceProviderButton opens an empty provider sheet. */
export function NewInferenceProviderButton() {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New provider
      </Button>
      <ProviderSheet key={open ? "new" : "closed"} open={open} onOpenChange={setOpen} />
    </>
  )
}
