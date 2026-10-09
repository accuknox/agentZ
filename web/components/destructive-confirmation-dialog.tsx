"use client"

import type { Route } from "next"
import { startTransition, useActionState, useId, useState } from "react"
import { useRouter } from "@bprogress/next/app"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { ShieldOffIcon, Trash2Icon, CircleAlert } from "lucide-react"
import { toast } from "sonner"
import { AlertDescription, AlertTitle, Alert } from "@/components/ui/alert"
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
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
  const form = useForm<{ confirmation: string }>({
    resolver: zodResolver(
      z.object({
        confirmation: z.literal(confirmation, {
          error: `Type ${confirmation} exactly to confirm.`,
        }),
      })
    ),
    defaultValues: { confirmation: "" },
  })
  const value = useWatch({ control: form.control, name: "confirmation" })
  const [state, formAction, pending] = useActionState<DestructiveConfirmationState, FormData>(
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
    if (!nextOpen) form.reset()
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

        <form
          noValidate
          className="contents"
          onSubmit={form.handleSubmit((values) => {
            const formData = new FormData()
            formData.set("confirmation", values.confirmation)
            formData.set("fingerprint", state.fingerprint ?? fingerprint)
            startTransition(() => formAction(formData))
          })}
        >
          {state.error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {kind === "disable" ? "Membership was not disabled" : "Deletion failed"}
              </AlertTitle>
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Controller
              name="confirmation"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={id} required>
                    Type <span className="font-mono">{confirmation}</span> to confirm
                  </FieldLabel>
                  <Input
                    {...field}
                    aria-label={`Type ${confirmation} to confirm`}
                    autoComplete="off"
                    autoFocus
                    id={id}
                    required
                    disabled={pending}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={fieldState.invalid ? `${id}-error` : undefined}
                  />
                  <FieldError id={`${id}-error`} errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>

          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={value !== confirmation || pending}
              type="submit"
              variant="destructive"
            >
              {pending ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
              {pending ? (kind === "disable" ? "Disabling..." : "Deleting...") : submitLabel}
            </Button>
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
