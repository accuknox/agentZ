"use client"

import { Plus } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"
import { Button } from "@/components/ui/button"
import { resourceLabels } from "@/lib/resource-labels"

export function NewMcpButton() {
  return (
    <SheetPrimitive.Trigger asChild>
      <Button>
        <Plus data-icon="inline-start" />
        {resourceLabels.mcp.action}
      </Button>
    </SheetPrimitive.Trigger>
  )
}
