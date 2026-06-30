"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { signInReturnTo, signInURL } from "@/lib/sign-in-redirect"

async function signInWithProvider(
  provider: "github" | "google",
  formData: FormData
): Promise<never> {
  const auth = getAuth()
  const returnTo = signInReturnTo(formData.get("returnTo")?.toString())
  const result = await auth.api.signInSocial({
    body: {
      callbackURL: returnTo ?? "/",
      disableRedirect: true,
      errorCallbackURL: signInURL({ returnTo }),
      provider,
    },
    headers: await headers(),
  })

  if (!result.url) {
    redirect(signInURL({ error: "no_callback_url", returnTo }))
  }

  redirect(result.url)
}

export async function signInWithGithub(formData: FormData): Promise<never> {
  return signInWithProvider("github", formData)
}

export async function signInWithGoogle(formData: FormData): Promise<never> {
  return signInWithProvider("google", formData)
}
