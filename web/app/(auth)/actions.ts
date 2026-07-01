"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import type { SocialProvider } from "@/app/(auth)/shared"
import { getAuth } from "@/lib/auth"
import { signInReturnTo, signInURL } from "@/lib/sign-in-redirect"

async function signInWithProvider(provider: SocialProvider, formData: FormData): Promise<never> {
  const auth = getAuth()
  const returnTo = signInReturnTo(formData.get("returnTo")?.toString())
  const authPath = formData.get("authPath") === "/signup" ? "/signup" : "/signin"
  const errorParams = new URLSearchParams()
  errorParams.set("provider", provider)
  if (returnTo) {
    errorParams.set("returnTo", returnTo)
  }
  const errorCallbackURL = `${authPath}?${errorParams.toString()}`
  const result = await auth.api.signInSocial({
    body: {
      callbackURL: returnTo ?? "/",
      disableRedirect: true,
      errorCallbackURL,
      provider,
    },
    headers: await headers(),
  })

  if (!result.url) {
    if (authPath === "/signup") {
      errorParams.set("error", "no_callback_url")
      redirect(`${authPath}?${errorParams.toString()}`)
    }

    redirect(signInURL({ error: "no_callback_url", provider, returnTo }))
  }

  redirect(result.url)
}

export async function signInWithGithub(formData: FormData): Promise<never> {
  return signInWithProvider("github", formData)
}

export async function signInWithGoogle(formData: FormData): Promise<never> {
  return signInWithProvider("google", formData)
}
