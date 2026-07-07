"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { useRouter } from "next/navigation"
import QRCode from "react-qr-code"
import { z } from "zod"
import { Download, ShieldCheck, ShieldOff, XIcon } from "lucide-react"
import type { AuthError, SocialProvider } from "@/app/(auth)/shared"
import { authErrorMessages } from "@/app/(auth)/shared"
import { reauthenticateWithGithub, reauthenticateWithGoogle } from "./actions"
import { SocialAuthButtons } from "@/components/auth/social-auth-buttons"
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

type ManageAction = "disable" | "enable"
type Provider = "credential" | SocialProvider
type TwoFactorSetup = {
  backupCodes: string[]
  totpURI: string
}

const manageResponseSchema = z.discriminatedUnion("status", [
  z.object({
    action: z.enum(["disable", "enable"], { error: "2FA action is invalid" }),
    provider: z.enum(["credential", "github", "google"], { error: "Re-auth provider is invalid" }),
    status: z.literal("reauth_required"),
  }),
  z.object({
    backupCodes: z.array(z.string()).optional(),
    status: z.literal("ok"),
    totpURI: z.string().optional(),
  }),
])

const manageErrorResponseSchema = z.object({
  message: z.string().optional(),
})

type ManageResponse = z.infer<typeof manageResponseSchema>

type TwoFactorSettingsProps = {
  email: string
  enabled: boolean
  intent?: ManageAction
  provider: Provider
  routeError?: AuthError
}

const reauthenticateSchema = z.object({
  password: z
    .string({ error: "Enter your current password." })
    .min(1, "Enter your current password."),
})

const totpCodeSchema = z
  .string({ error: "Enter a valid 6-digit code" })
  .trim()
  .regex(/^\d{6}$/, "Enter a valid 6-digit code")

const twoFactorRedirectResponseSchema = z.object({
  twoFactorRedirect: z.literal(true),
})

/**
 * TwoFactorSettings keeps 2FA management behind a recent-sign-in gate and
 * resumes the intended action after re-auth instead of surfacing raw auth
 * plugin errors in the enrollment dialog.
 */
export function TwoFactorSettings({
  email,
  enabled,
  intent,
  provider,
  routeError,
}: TwoFactorSettingsProps) {
  const router = useRouter()
  const consumedIntentRef = React.useRef<string | undefined>(undefined)
  const [setup, setSetup] = React.useState<TwoFactorSetup>()
  const [mode, setMode] = React.useState<"disable" | "idle" | "loading" | "reauth" | "setup">(
    "idle"
  )
  const [pendingAction, setPendingAction] = React.useState<ManageAction>()
  const [requestedAction, setRequestedAction] = React.useState<ManageAction>("enable")
  const [error, setError] = React.useState<string>()
  const [pendingProvider, setPendingProvider] = React.useState<SocialProvider>()
  const [, startTransition] = React.useTransition()
  const form = useForm<z.infer<typeof reauthenticateSchema>>({
    criteriaMode: "all",
    defaultValues: {
      password: "",
    },
    mode: "onSubmit",
    reValidateMode: "onBlur",
    resolver: zodResolver(reauthenticateSchema),
  })

  const open = mode !== "idle"
  const verifying = pendingAction === "enable" && mode === "setup"
  const disabling = pendingAction === "disable" && mode === "disable"
  const reauthenticating = pendingAction !== undefined && mode === "reauth"
  const socialError =
    routeError && provider !== "credential" ? authErrorMessages[routeError] : undefined

  const socialActions = {
    github: reauthenticateWithGithub,
    google: reauthenticateWithGoogle,
  } satisfies Record<SocialProvider, (formData: FormData) => Promise<void>>

  React.useEffect(() => {
    if (!intent) {
      return
    }

    queueMicrotask(() => {
      if (consumedIntentRef.current === intent) {
        return
      }

      consumedIntentRef.current = intent
      window.history.replaceState({}, "", window.location.pathname)
      setPendingProvider(undefined)
      if (intent === "disable") {
        setError(undefined)
        setMode("disable")
        return
      }

      void startEnable()
    })
  }, [intent])

  async function manage(action: ManageAction): Promise<ManageResponse> {
    const response = await fetch("/api/account/two-factor", {
      body: JSON.stringify({ action }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })
    const payload = await response.json()
    const parsed = manageResponseSchema.safeParse(payload)
    if (!response.ok && parsed.success && parsed.data.status === "reauth_required") {
      return parsed.data
    }
    if (!response.ok || !parsed.success || parsed.data.status !== "ok") {
      const error = manageErrorResponseSchema.safeParse(payload)
      throw new Error(error.success ? (error.data.message ?? "Request failed") : "Request failed")
    }
    return parsed.data
  }

  const startEnable = React.useEffectEvent(async (): Promise<void> => {
    setPendingAction("enable")
    setRequestedAction("enable")
    setError(undefined)
    setSetup(undefined)
    setMode("loading")

    try {
      const result = await manage("enable")
      if (result.status === "reauth_required") {
        setMode("reauth")
        return
      }
      if (!result.totpURI || !result.backupCodes) {
        throw new Error("Failed to start setup")
      }
      setSetup({
        backupCodes: result.backupCodes,
        totpURI: result.totpURI,
      })
      setMode("setup")
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to start setup")
      setMode("idle")
    } finally {
      setPendingAction(undefined)
    }
  })

  async function submitCredentialReauth(
    values: z.infer<typeof reauthenticateSchema>
  ): Promise<void> {
    const returnTo = `/settings/account?manage2fa=${requestedAction}`
    setPendingAction(requestedAction)
    setError(undefined)

    try {
      const result = await authClient.signIn.email({
        callbackURL: returnTo,
        email,
        password: values.password,
      })
      if (result.error) {
        form.setError("password", {
          message:
            result.error.status === 401
              ? authErrorMessages.invalid_email_or_password
              : (result.error.message ?? "Sign-in could not be completed. Try again."),
          type: "server",
        })
        return
      }

      const data = result.data
      if (twoFactorRedirectResponseSchema.safeParse(data).success) {
        window.location.replace(`/signin/two-factor?returnTo=${encodeURIComponent(returnTo)}`)
        return
      }

      window.location.replace(returnTo)
    } finally {
      setPendingAction(undefined)
    }
  }

  async function verify(code: string): Promise<string | undefined> {
    const parsed = totpCodeSchema.safeParse(code)
    if (!parsed.success) {
      return parsed.error.issues[0]?.message
    }

    setPendingAction("enable")
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: parsed.data })
      if (result.error) {
        return result.error.message ?? "Invalid code"
      }
      close()
      startTransition(() => {
        router.refresh()
      })
      return
    } catch {
      return "Invalid code"
    } finally {
      setPendingAction(undefined)
    }
  }

  async function disable(): Promise<void> {
    setPendingAction("disable")
    setRequestedAction("disable")
    setError(undefined)

    try {
      const result = await manage("disable")
      if (result.status === "reauth_required") {
        setMode("reauth")
        return
      }
      close()
      startTransition(() => {
        router.refresh()
      })
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to disable 2FA")
    } finally {
      setPendingAction(undefined)
    }
  }

  function close(): void {
    setMode("idle")
    setError(undefined)
    setPendingProvider(undefined)
    setSetup(undefined)
    setRequestedAction("enable")
    form.reset()
    form.clearErrors()
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
            disabled={open}
            onCheckedChange={(checked) => {
              if (checked) {
                void startEnable()
                return
              }
              setError(undefined)
              setMode("disable")
            }}
            aria-label={enabled ? "Disable authenticator app" : "Enable authenticator app"}
          />
        </div>
      </div>
      {!open && error ? <FieldError>{error}</FieldError> : null}
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            return
          }
          close()
        }}
      >
        <DialogContent
          className={
            mode === "setup"
              ? "flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-0 sm:max-w-xl"
              : undefined
          }
          showCloseButton={mode !== "setup"}
        >
          {mode === "setup" && setup ? (
            <SetupDialog
              error={error}
              pending={verifying}
              setup={setup}
              onCloseAction={close}
              onVerifyAction={verify}
            />
          ) : null}
          {mode === "loading" ? <LoadingDialog /> : null}
          {mode === "reauth" ? (
            <ReauthDialog
              action={requestedAction}
              credential={provider === "credential"}
              error={error ?? socialError}
              form={form}
              pending={reauthenticating}
              pendingProvider={pendingProvider}
              provider={provider}
              socialActions={socialActions}
              onCredentialSubmitAction={submitCredentialReauth}
              onPendingProviderAction={setPendingProvider}
            />
          ) : null}
          {mode === "disable" ? (
            <DisableDialog error={error} pending={disabling} onDisableAction={disable} />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function SetupDialog({
  error,
  onCloseAction,
  onVerifyAction,
  pending,
  setup,
}: {
  error: string | undefined
  onCloseAction: () => void
  onVerifyAction: (code: string) => Promise<string | undefined>
  pending: boolean
  setup: TwoFactorSetup
}) {
  const [secretMode, setSecretMode] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [codeError, setCodeError] = React.useState<string>()
  const secret = new URL(setup.totpURI).searchParams.get("secret") ?? ""

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setCodeError(undefined)

    const nextError = await onVerifyAction(code)
    if (nextError) {
      setCodeError(nextError)
    }
  }

  return (
    <>
      <div className="bg-popover flex shrink-0 items-start justify-between gap-4 p-4">
        <DialogHeader className="min-w-0 pt-1">
          <DialogTitle>Connect your authenticator app</DialogTitle>
          <DialogDescription className="sr-only">
            Scan the QR code or enter the secret, then verify the 6-digit code.
          </DialogDescription>
        </DialogHeader>
        <Button variant="ghost" className="shrink-0" size="icon-sm" onClick={onCloseAction}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pb-4">
          {error ? <FieldError>{error}</FieldError> : null}
          <form className="flex flex-col gap-6" onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-6">
              {secretMode ? (
                <div className="flex flex-col gap-4">
                  <p className="font-medium">
                    Step 1: Enter the secret code below in your authenticator app, then enter the
                    6-digit code from the app.
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
                    Step 1: Scan the QR code using your authenticator app, then enter the 6-digit
                    code from the app.
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
                <Field data-invalid={!!codeError}>
                  <FieldLabel htmlFor="two-factor-code" required>
                    Step 2: Enter your 6-digit code
                  </FieldLabel>
                  <Input
                    id="two-factor-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    aria-invalid={!!codeError}
                    aria-required="true"
                    disabled={pending}
                    placeholder="Enter your 6-digit code"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value)
                      if (codeError) {
                        setCodeError(undefined)
                      }
                    }}
                  />
                  {codeError ? <FieldError>{codeError}</FieldError> : null}
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
        </div>
      </div>
    </>
  )
}

function LoadingDialog() {
  return (
    <div className="flex min-h-36 items-center justify-center">
      <Spinner />
    </div>
  )
}

function ReauthDialog({
  action,
  credential,
  error,
  form,
  onCredentialSubmitAction,
  onPendingProviderAction,
  pending,
  pendingProvider,
  provider,
  socialActions,
}: {
  action: ManageAction
  credential: boolean
  error: string | undefined
  form: ReturnType<typeof useForm<z.infer<typeof reauthenticateSchema>>>
  onCredentialSubmitAction: (values: z.infer<typeof reauthenticateSchema>) => Promise<void>
  onPendingProviderAction: (provider: SocialProvider) => void
  pending: boolean
  pendingProvider: SocialProvider | undefined
  provider: Provider
  socialActions: Record<SocialProvider, (formData: FormData) => Promise<void>>
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          For your security, confirm it&apos;s you before{" "}
          {action === "enable" ? "enabling" : "disabling"} two-factor authentication.
        </DialogDescription>
      </DialogHeader>
      {credential ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit((values) => void onCredentialSubmitAction(values))}
          noValidate
        >
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.password}>
              <FieldLabel htmlFor="two-factor-reauth-password" required>
                Current password
              </FieldLabel>
              <Input
                id="two-factor-reauth-password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!form.formState.errors.password}
                disabled={pending}
                {...form.register("password", {
                  onChange: () => {
                    if (form.formState.errors.password) {
                      form.clearErrors("password")
                    }
                  },
                })}
              />
              {form.formState.errors.password ? (
                <FieldError errors={[form.formState.errors.password]} />
              ) : null}
            </Field>
          </FieldGroup>
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Continue
            </Button>
          </DialogFooter>
        </form>
      ) : provider === "github" || provider === "google" ? (
        <>
          {error ? <FieldError>{error}</FieldError> : null}
          <SocialAuthButtons
            actions={socialActions}
            authPath="/signin"
            disabled={pending}
            errors={error ? { [provider]: error } : undefined}
            hiddenFields={{ action }}
            onPendingChangeAction={onPendingProviderAction}
            pendingProvider={pendingProvider}
            providers={[provider]}
            returnTo={undefined}
            submitLabel="Sign in"
          />
        </>
      ) : null}
    </>
  )
}

function DisableDialog({
  error,
  onDisableAction,
  pending,
}: {
  error: string | undefined
  onDisableAction: () => Promise<void>
  pending: boolean
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Disable two-factor authentication?</DialogTitle>
        <DialogDescription>
          You&apos;ll stop being asked for authenticator codes on sign-in.
        </DialogDescription>
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
            void onDisableAction()
          }}
        >
          {pending ? <Spinner data-icon="inline-start" /> : <ShieldOff data-icon="inline-start" />}
          Disable
        </Button>
      </DialogFooter>
    </>
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

async function downloadBackupCodes(codes: string[]): Promise<void> {
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
