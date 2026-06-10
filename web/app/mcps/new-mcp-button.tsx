"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { McpFormState, SubmitMcpFormAction } from "@/data/mcp.actions"
import { McpSheet } from "./mcp-sheet"

export function NewMcpButton({
  submitMcpAction,
}: {
  submitMcpAction: (_: McpFormState, action: SubmitMcpFormAction) => Promise<McpFormState>
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New MCP
      </Button>
      <McpSheet
        mode="create"
        open={open}
        onOpenChangeAction={setOpen}
        submitMcpAction={submitMcpAction}
      />
    </>
  )
}
