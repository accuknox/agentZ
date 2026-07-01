"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import type { SocialProvider } from "@/app/(auth)/shared"
import { getAuth } from "@/lib/auth"

async function reauthenticateWithProvider(
  provider: SocialProvider,
  formData: FormData
): Promise<never> {
  const auth = getAuth()
  const action = formData.get("action")
  const manageAction = action === "disable" ? "disable" : "enable"
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
    headers: await headers(),
  })

  if (!result.url) {
    redirect(`/settings/account?${errorParams.toString()}`)
  }

  redirect(result.url)
}

export async function reauthenticateWithGithub(formData: FormData): Promise<never> {
  return reauthenticateWithProvider("github", formData)
}

export async function reauthenticateWithGoogle(formData: FormData): Promise<never> {
  return reauthenticateWithProvider("google", formData)
}
