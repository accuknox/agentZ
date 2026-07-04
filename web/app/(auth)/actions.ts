"use server"

import type { Route } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import * as z from "zod"
import type { SocialProvider } from "@/app/(auth)/shared"
import { getAuth } from "@/lib/auth"
import { signInReturnTo, signInURL } from "@/lib/sign-in-redirect"

const providerSignInFormSchema = z.object({
  returnTo: z.string().optional().catch(undefined),
  authPath: z.enum(["/signin", "/signup"]).catch("/signin"),
})

async function signInWithProvider(provider: SocialProvider, formData: FormData): Promise<never> {
  const requestHeaders = await headers()
  const auth = getAuth()
  const parsed = providerSignInFormSchema.parse(Object.fromEntries(formData))
  const returnTo = signInReturnTo(parsed.returnTo)
  const authPath = parsed.authPath
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
    headers: requestHeaders,
  })

  if (!result.url) {
    if (authPath === "/signup") {
      errorParams.set("error", "no_callback_url")
      redirect(`${authPath}?${errorParams.toString()}`)
    }

    redirect(signInURL({ error: "no_callback_url", provider, returnTo }))
  }

  redirect(result.url as Route)
}

export async function signInWithGithub(formData: FormData): Promise<never> {
  return signInWithProvider("github", formData)
}

export async function signInWithGoogle(formData: FormData): Promise<never> {
  return signInWithProvider("google", formData)
}
