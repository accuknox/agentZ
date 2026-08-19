"use client"

import type { Route } from "next"
import { useActionState, useId, useState } from "react"
import { useRouter } from "@bprogress/next/app"
import { useFormStatus } from "react-dom"
import { CircleAlertIcon, ShieldOffIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogAlert,
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
  kind = "delete",
  onOpenChange,
  open,
  showTrigger = true,
  submitLabel,
  successMessage,
  title,
}: {
  action: (
    state: DestructiveConfirmationState,
    formData: FormData
  ) => Promise<DestructiveConfirmationState>
  confirmation: string
  fingerprint: string
  kind?: "delete" | "disable"
  onOpenChange?: (open: boolean) => void
  open?: boolean
  showTrigger?: boolean
  submitLabel: string
  successMessage: string
  title: string
}) {
  const router = useRouter()
  const id = useId()
  const [internalOpen, setInternalOpen] = useState(false)
  const [value, setValue] = useState("")
  const [state, formAction] = useActionState<DestructiveConfirmationState, FormData>(
    async (state, formData) => {
      const result = await action(state, formData)
      if (result.href) {
        toast.success(successMessage)
        router.push(result.href)
      }
      return result
    },
    {}
  )
  const Icon = kind === "disable" ? ShieldOffIcon : Trash2Icon

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
          <Button type="button" variant={kind === "disable" ? "outline" : "destructive"}>
            <Icon data-icon="inline-start" />
            {submitLabel}
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind === "disable"
              ? "Access is revoked immediately. You can restore this Membership later."
              : "You cannot undo this action."}
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="contents">
          <input name="fingerprint" type="hidden" value={state.fingerprint ?? fingerprint} />
          {state.error ? (
            <DialogAlert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>
                {kind === "disable" ? "Membership was not disabled" : "Deletion failed"}
              </AlertTitle>
              <AlertDescription>{state.error}</AlertDescription>
            </DialogAlert>
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
            <ConfirmationSubmit disabled={value !== confirmation} kind={kind} label={submitLabel} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type DestructiveConfirmationState = {
  error?: string
  fingerprint?: string
  href?: Route
}

function ConfirmationSubmit({
  disabled,
  kind,
  label,
}: {
  disabled: boolean
  kind: "delete" | "disable"
  label: string
}) {
  const { pending } = useFormStatus()
  const Icon = kind === "disable" ? ShieldOffIcon : Trash2Icon

  return (
    <Button disabled={disabled || pending} type="submit" variant="destructive">
      {pending ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
      {pending ? (kind === "disable" ? "Disabling..." : "Deleting...") : label}
    </Button>
  )
}
