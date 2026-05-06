"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SecretSheet } from "./secret-sheet"
import type { PutSecretFormState } from "@/data/types"

export function NewSecretButton({
  sessionID,
  putSecretAction,
}: {
  sessionID: string
  putSecretAction: (
    sessionID: string,
    state: PutSecretFormState,
    formData: FormData
  ) => Promise<PutSecretFormState>
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        New secret
      </Button>
      <SecretSheet
        sessionID={sessionID}
        mode="create"
        putSecretAction={putSecretAction}
        open={open}
        onOpenChangeAction={setOpen}
      />
    </>
  )
}
