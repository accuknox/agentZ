"use client"

import { useId, useState } from "react"
import { useFormStatus } from "react-dom"
import { Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"

export function DestructiveConfirmation({
  action,
  confirmation,
  fingerprint,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>
  confirmation: string
  fingerprint: string
  submitLabel: string
}) {
  const id = useId()
  const [value, setValue] = useState("")
  return (
    <form action={action} className="grid gap-4">
      <input name="fingerprint" type="hidden" value={fingerprint} />
      <div className="grid gap-2">
        <Label htmlFor={id}>
          Type <span className="font-mono">{confirmation}</span> to confirm
        </Label>
        <Input
          aria-label={`Type ${confirmation} to confirm`}
          autoComplete="off"
          id={id}
          name="confirmation"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      </div>
      <ConfirmationSubmit disabled={value !== confirmation} label={submitLabel} />
    </form>
  )
}

function ConfirmationSubmit({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button disabled={disabled || pending} type="submit" variant="destructive">
      {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
      {label}
    </Button>
  )
}
