import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { signInWithGithub, signInWithGoogle } from "@/app/(auth)/actions"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { AuthPage } from "@/components/auth/auth-page"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { signInReturnTo, signInURL } from "@/lib/sign-in-redirect"
import {
  authSearchParamsSchema,
  socialProviders,
  type AuthSearchParams,
  type SocialProvider,
} from "../shared"

export const metadata: Metadata = {
  title: "Sign Up",
}

const providerActions = {
  github: signInWithGithub,
  google: signInWithGoogle,
} satisfies Record<SocialProvider, (formData: FormData) => Promise<never>>

export default function SignUpPage({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return (
    <AuthPage>
      <SignUpGate searchParams={searchParams} />
    </AuthPage>
  )
}

async function SignUpGate({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  const requestHeaders = await headers()
  const auth = getAuth()
  const params = authSearchParamsSchema.parse(await searchParams)
  const returnTo = signInReturnTo(params.returnTo)
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (session) {
    redirect(returnTo ?? "/")
  }

  if (!getEnv().ENABLE_EMAIL_PASSWORD_AUTH) {
    redirect(signInURL({ error: params.error, provider: params.provider, returnTo }))
  }

  return (
    <SignUpForm
      key={`${params.error ?? ""}:${params.provider ?? ""}:${returnTo ?? ""}`}
      actions={providerActions}
      providers={socialProviders()}
      routeError={params.error}
      routeProvider={params.provider}
      returnTo={returnTo}
    />
  )
}
