"use client"

import { useActionState, useId, useState } from "react"
import { useFormStatus } from "react-dom"
import { CircleAlertIcon, Trash2Icon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

export function DestructiveConfirmationDialog({
  action,
  confirmation,
  fingerprint,
  onOpenChange,
  open,
  showTrigger = true,
  submitLabel,
  title,
}: {
  action: (
    state: DestructiveConfirmationState,
    formData: FormData
  ) => Promise<DestructiveConfirmationState>
  confirmation: string
  fingerprint: string
  onOpenChange?: (open: boolean) => void
  open?: boolean
  showTrigger?: boolean
  submitLabel: string
  title: string
}) {
  const id = useId()
  const [internalOpen, setInternalOpen] = useState(false)
  const [value, setValue] = useState("")
  const [state, formAction] = useActionState(action, {})

  const dialogOpen = open ?? internalOpen
  const setOpen = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
    if (!nextOpen) setValue("")
  }

  return (
    <Dialog onOpenChange={setOpen} open={dialogOpen}>
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button type="button" variant="destructive">
            <Trash2Icon data-icon="inline-start" />
            {submitLabel}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This action is permanent and cannot be undone.</DialogDescription>
        </DialogHeader>

        <form action={formAction} className="contents">
          <input name="fingerprint" type="hidden" value={state.fingerprint ?? fingerprint} />
          {state.error ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>Deletion failed</AlertTitle>
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={id}>
                Type <span className="font-mono">{confirmation}</span> to confirm
              </FieldLabel>
              <Input
                aria-label={`Type ${confirmation} to confirm`}
                autoComplete="off"
                autoFocus
                id={id}
                name="confirmation"
                onChange={(event) => setValue(event.target.value)}
                value={value}
              />
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <ConfirmationSubmit disabled={value !== confirmation} label={submitLabel} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type DestructiveConfirmationState = { error?: string; fingerprint?: string }

function ConfirmationSubmit({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus()

  return (
    <Button disabled={disabled || pending} type="submit" variant="destructive">
      {pending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
      {pending ? "Deleting..." : label}
    </Button>
  )
}
