"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import QRCode from "react-qr-code"
import { Download, ShieldCheck, ShieldOff, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { authClient } from "@/lib/auth-client"

type TwoFactorSetup = NonNullable<Awaited<ReturnType<typeof authClient.twoFactor.enable>>["data"]>
type TOTPEnrollmentVerificationValues = {
  code: string
}

type TwoFactorSettingsProps = {
  enabled: boolean
}

export function TwoFactorSettings({ enabled }: TwoFactorSettingsProps) {
  const [enableOpen, setEnableOpen] = React.useState(false)
  const [disableOpen, setDisableOpen] = React.useState(false)
  const [enableSetup, setEnableSetup] = React.useState<TwoFactorSetup>()
  const [enablePending, setEnablePending] = React.useState(false)
  const [enableError, setEnableError] = React.useState<string>()
  const enableRequestIDRef = React.useRef(0)

  async function startEnableSetup() {
    const requestID = enableRequestIDRef.current + 1
    enableRequestIDRef.current = requestID
    setEnableOpen(true)
    setEnablePending(true)
    setEnableError(undefined)
    try {
      const result = await authClient.twoFactor.enable({})
      if (requestID !== enableRequestIDRef.current) {
        return
      }
      if (result.error || !result.data) {
        setEnableError(result.error?.message ?? "Failed to start setup")
        return
      }
      new URL(result.data.totpURI)
      setEnableSetup(result.data)
    } catch {
      if (requestID === enableRequestIDRef.current) {
        setEnableError("Failed to start setup")
      }
    } finally {
      if (requestID === enableRequestIDRef.current) {
        setEnablePending(false)
      }
    }
  }

  return (
    <section className="flex flex-col gap-4 px-4 md:px-6">
      <h2 className="text-lg font-semibold tracking-normal">Two-Factor Authentication</h2>
      <div className="w-full max-w-2xl">
        <div className="flex min-h-20 items-center justify-between gap-4 py-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium">Authenticator app</div>
            <div className="text-muted-foreground mt-1">
              Use one-time codes from an authenticator app.
            </div>
          </div>
          <Switch
            checked={enabled}
            disabled={enablePending}
            onCheckedChange={(checked) => {
              if (checked) {
                void startEnableSetup()
                return
              }
              setDisableOpen(true)
            }}
            aria-label={enabled ? "Disable authenticator app" : "Enable authenticator app"}
          />
        </div>
      </div>
      <EnableTwoFactorDialog
        enableError={enableError}
        open={enableOpen}
        pending={enablePending}
        setup={enableSetup}
        onOpenChangeAction={(open) => {
          setEnableOpen(open)
          if (open) {
            return
          }
          enableRequestIDRef.current += 1
          setEnableSetup(undefined)
          setEnableError(undefined)
          setEnablePending(false)
        }}
      />
      <DisableTwoFactorDialog open={disableOpen} onOpenChangeAction={setDisableOpen} />
    </section>
  )
}

function EnableTwoFactorDialog({
  enableError,
  onOpenChangeAction,
  open,
  pending: enablePending,
  setup,
}: {
  enableError: string | undefined
  onOpenChangeAction: (open: boolean) => void
  open: boolean
  pending: boolean
  setup: TwoFactorSetup | undefined
}) {
  const router = useRouter()
  const [, startTransition] = React.useTransition()
  const [pending, setPending] = React.useState(false)
  const [secretMode, setSecretMode] = React.useState(false)
  const form = useForm<TOTPEnrollmentVerificationValues>({
    defaultValues: {
      code: "",
    },
  })
  const secret = setup ? (new URL(setup.totpURI).searchParams.get("secret") ?? "") : ""

  async function verify(values: TOTPEnrollmentVerificationValues) {
    if (!/^\d{6}$/.test(values.code)) {
      form.setError("code", {
        type: "validate",
        message: "Enter a valid 6-digit code",
      })
      return
    }

    setPending(true)

    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: values.code,
      })
      if (result.error) {
        form.setError("code", {
          type: "server",
          message: result.error.message ?? "Invalid code",
        })
        return
      }

      onOpenChangeAction(false)
      form.reset()
      startTransition(() => {
        router.refresh()
      })
    } catch {
      form.setError("code", {
        type: "server",
        message: "Invalid code",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChangeAction(nextOpen)
        if (nextOpen) {
          return
        }
        form.reset()
        setSecretMode(false)
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <div className="bg-popover flex shrink-0 items-start justify-between gap-4 p-4">
          <DialogHeader className="min-w-0 pt-1">
            <DialogTitle>Connect your authenticator app</DialogTitle>
            <DialogDescription className="sr-only">
              Scan the QR code or enter the secret, then verify the 6-digit code.
            </DialogDescription>
          </DialogHeader>
          <DialogClose asChild>
            <Button variant="ghost" className="shrink-0" size="icon-sm">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 pb-4">
            {enableError ? <FieldError>{enableError}</FieldError> : null}
            {setup ? (
              <form className="flex flex-col gap-6" onSubmit={form.handleSubmit(verify)}>
                <div className="flex flex-col gap-6">
                  {secretMode ? (
                    <div className="flex flex-col gap-4">
                      <p className="font-medium">
                        Step 1: Enter the secret code below in your authenticator app, then enter
                        the 6-digit code from the app.
                      </p>
                      <div className="border-border flex min-h-44 flex-col items-center justify-center gap-4 rounded-lg border p-6">
                        <div className="border-border bg-background w-full rounded-md border px-4 py-3 text-center font-mono text-lg break-all">
                          {secret}
                        </div>
                        <CopyButton content={secret} label="Copy code" />
                        <Button type="button" variant="link" onClick={() => setSecretMode(false)}>
                          Show QR code instead
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <p className="font-medium">
                        Step 1: Scan the QR code using your authenticator app, then enter the
                        6-digit code from the app.
                      </p>
                      <div className="border-border flex min-h-80 flex-col items-center justify-center gap-3 rounded-lg border p-6">
                        <div className="bg-background p-3 text-black">
                          <QRCode value={setup.totpURI} className="size-56" />
                        </div>
                        <Button type="button" variant="link" onClick={() => setSecretMode(true)}>
                          Trouble scanning?
                        </Button>
                      </div>
                    </div>
                  )}
                  <FieldGroup>
                    <Field data-invalid={!!form.formState.errors.code}>
                      <FieldLabel htmlFor="two-factor-code" required>
                        Step 2: Enter your 6-digit code
                      </FieldLabel>
                      <Input
                        id="two-factor-code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]*"
                        maxLength={6}
                        aria-invalid={!!form.formState.errors.code}
                        aria-required="true"
                        placeholder="Enter your 6-digit code"
                        {...form.register("code")}
                      />
                      {form.formState.errors.code ? (
                        <FieldError errors={[form.formState.errors.code]} />
                      ) : null}
                    </Field>
                    <BackupCodes codes={setup.backupCodes} />
                  </FieldGroup>
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline" disabled={pending}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button type="submit" disabled={pending}>
                    {pending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <ShieldCheck data-icon="inline-start" />
                    )}
                    Verify
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              <div className="flex min-h-36 items-center justify-center">
                {enablePending ? <Spinner /> : null}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DisableTwoFactorDialog({
  onOpenChangeAction,
  open,
}: {
  onOpenChangeAction: (open: boolean) => void
  open: boolean
}) {
  const router = useRouter()
  const [, startTransition] = React.useTransition()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string>()

  async function disable() {
    setPending(true)
    setError(undefined)
    try {
      const result = await authClient.twoFactor.disable({})
      if (result.error) {
        setError(result.error.message ?? "Failed to disable 2FA")
        return
      }

      onOpenChangeAction(false)
      startTransition(() => {
        router.refresh()
      })
    } catch {
      setError("Failed to disable 2FA")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChangeAction(nextOpen)
        if (!nextOpen) {
          setError(undefined)
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication?</DialogTitle>
        </DialogHeader>
        {error ? <FieldError>{error}</FieldError> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              void disable()
            }}
          >
            {pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ShieldOff data-icon="inline-start" />
            )}
            Disable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>Backup codes</FieldLabel>
        <Button type="button" variant="outline" onClick={() => void downloadBackupCodes(codes)}>
          <Download data-icon="inline-start" />
          Download
        </Button>
      </div>
      <div className="border-border bg-muted/30 grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-xs sm:grid-cols-3">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
    </Field>
  )
}

async function downloadBackupCodes(codes: string[]) {
  if (codes.length === 0) {
    return
  }

  const blob = new Blob([codes.join("\n")], { type: "text/plain" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codes[0]))
  const fileID = Array.from(new Uint8Array(hashBuffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, 12)
  link.href = url
  link.download = `${fileID}.txt`
  document.body.append(link)
  link.click()
  link.remove()
  queueMicrotask(() => URL.revokeObjectURL(url))
}
