"use client"

import Image from "next/image"
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { TWO_FACTOR_ERROR_CODES } from "better-auth/plugins/two-factor"
import { Controller, useForm } from "react-hook-form"
import * as z from "zod"
import { authClient } from "@/lib/auth-client"
import { signInURL } from "@/lib/sign-in-redirect"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type TwoFactorChallengeProps = {
  returnTo: string
}

type ChallengeMode = "totp" | "backup"

const invalidChallengeMessages = new Set([
  TWO_FACTOR_ERROR_CODES.INVALID_TWO_FACTOR_COOKIE.message,
  TWO_FACTOR_ERROR_CODES.TWO_FACTOR_NOT_ENABLED.message,
  TWO_FACTOR_ERROR_CODES.TOTP_NOT_ENABLED.message,
  TWO_FACTOR_ERROR_CODES.BACKUP_CODES_NOT_ENABLED.message,
])

const challengeSchemas = {
  totp: z.object({
    code: z
      .string({ error: "Enter a valid 6-digit code" })
      .trim()
      .regex(/^\d{6}$/, "Enter a valid 6-digit code"),
    trustDevice: z.boolean({ error: "Remember-device selection is required" }),
  }),
  backup: z.object({
    code: z.string({ error: "Enter a backup code" }).trim().min(1, "Enter a backup code"),
    trustDevice: z.boolean({ error: "Remember-device selection is required" }),
  }),
}

type TwoFactorChallengeValues = z.infer<(typeof challengeSchemas)["totp"]>

export function TwoFactorChallenge({ returnTo }: TwoFactorChallengeProps) {
  const [mode, setMode] = React.useState<ChallengeMode>("totp")
  const [pending, setPending] = React.useState(false)
  const [redirecting, setRedirecting] = React.useState(false)
  const locked = pending || redirecting
  const form = useForm<TwoFactorChallengeValues>({
    resolver: zodResolver(challengeSchemas[mode]),
    defaultValues: {
      code: "",
      trustDevice: false,
    },
  })

  async function submit(values: TwoFactorChallengeValues) {
    setPending(true)
    form.clearErrors("code")
    let redirected = false

    try {
      const result =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({
              code: values.code,
              trustDevice: values.trustDevice,
            })
          : await authClient.twoFactor.verifyBackupCode({
              code: values.code,
              trustDevice: values.trustDevice,
            })

      if (result.error) {
        const message = result.error.message ?? "Sign-in could not be completed. Try again."

        if (
          message === TWO_FACTOR_ERROR_CODES.INVALID_CODE.message ||
          message === TWO_FACTOR_ERROR_CODES.INVALID_BACKUP_CODE.message
        ) {
          form.setError("code", {
            type: "server",
            message,
          })
          return
        }

        if (invalidChallengeMessages.has(message)) {
          redirected = true
          setRedirecting(true)
          window.location.replace(signInURL({ error: "session_expired", returnTo }))
          return
        }

        form.setError("code", {
          type: "server",
          message: "Sign-in could not be completed. Try again.",
        })
        return
      }

      redirected = true
      setRedirecting(true)
      window.location.replace(returnTo)
    } catch {
      form.setError("code", {
        type: "server",
        message: "Sign-in could not be completed. Try again.",
      })
    } finally {
      if (redirected) {
        return
      }
      setPending(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-8 pt-10">
      <div className="flex items-center justify-center gap-3">
        <Image src="/emblem.svg" alt="AccuKnox emblem" width={40} height={40} className="size-10" />
        <span className="text-foreground text-3xl font-semibold tracking-tight">AccuKnox</span>
      </div>

      <section className="flex flex-col gap-5">
        <form
          className="flex flex-col gap-5"
          onSubmit={form.handleSubmit(submit)}
          aria-busy={locked}
        >
          <Tabs
            value={mode}
            onValueChange={(value) => {
              if (value !== "totp" && value !== "backup") {
                return
              }
              setMode(value)
              form.resetField("code")
              form.clearErrors("code")
            }}
          >
            <TabsList className="h-9 w-full">
              <TabsTrigger value="totp" disabled={locked}>
                Authenticator code
              </TabsTrigger>
              <TabsTrigger value="backup" disabled={locked}>
                Backup code
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.code}>
              <FieldLabel htmlFor="two-factor-signin-code" required>
                {mode === "totp" ? "6-digit code" : "Backup code"}
              </FieldLabel>
              <Input
                id="two-factor-signin-code"
                inputMode={mode === "totp" ? "numeric" : "text"}
                autoComplete={mode === "totp" ? "one-time-code" : "off"}
                maxLength={mode === "totp" ? 6 : undefined}
                pattern={mode === "totp" ? "[0-9]*" : undefined}
                placeholder={mode === "totp" ? "000000" : "Enter a backup code"}
                disabled={locked}
                aria-invalid={!!form.formState.errors.code}
                aria-required="true"
                {...form.register("code")}
              />
              {form.formState.errors.code ? (
                <FieldError>{form.formState.errors.code.message}</FieldError>
              ) : null}
            </Field>

            <Field orientation="horizontal">
              <Controller
                name="trustDevice"
                control={form.control}
                render={({ field }) => (
                  <>
                    <Checkbox
                      id="trust-device"
                      checked={field.value}
                      disabled={locked}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true)
                      }}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="trust-device">
                        Remember this device for 30 days
                      </FieldLabel>
                    </FieldContent>
                  </>
                )}
              />
            </Field>
          </FieldGroup>

          <div className="flex flex-col gap-3">
            <Button type="submit" size="lg" disabled={locked}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setRedirecting(true)
                window.location.replace(signInURL({ returnTo }))
              }}
            >
              Back
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}
