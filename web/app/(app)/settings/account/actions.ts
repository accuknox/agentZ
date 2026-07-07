"use server"

import type { Route } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import * as z from "zod"
import type { SocialProvider } from "@/app/(auth)/shared"
import { getAuth } from "@/lib/auth"

const reauthenticationFormSchema = z.object({
  action: z.enum(["enable", "disable"], { error: "2FA action is invalid" }).catch("enable"),
})

async function reauthenticateWithProvider(
  provider: SocialProvider,
  formData: FormData
): Promise<never> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const { action: manageAction } = reauthenticationFormSchema.parse(Object.fromEntries(formData))
  const callbackURL = `/settings/account?manage2fa=${manageAction}`
  const errorParams = new URLSearchParams()
  errorParams.set("error", "no_callback_url")
  errorParams.set("manage2fa", manageAction)
  errorParams.set("provider", provider)

  const result = await auth.api.signInSocial({
    body: {
      callbackURL,
      disableRedirect: true,
      errorCallbackURL: `/settings/account?manage2fa=${manageAction}&provider=${provider}`,
      provider,
    },
    headers: requestHeaders,
  })

  if (!result.url) {
    redirect(`/settings/account?${errorParams.toString()}`)
  }

  redirect(result.url as Route)
}

export async function reauthenticateWithGithub(formData: FormData): Promise<never> {
  return reauthenticateWithProvider("github", formData)
}

export async function reauthenticateWithGoogle(formData: FormData): Promise<never> {
  return reauthenticateWithProvider("google", formData)
}
