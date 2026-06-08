"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { McpSheet } from "./mcp-sheet"
import type { McpFormState } from "@/data/mcp.actions"

export function NewMcpButton({
  submitMcpAction,
}: {
  submitMcpAction: (_: McpFormState, formData: FormData) => Promise<McpFormState>
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
