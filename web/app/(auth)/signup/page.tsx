import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import { signInWithGithub, signInWithGoogle } from "@/app/(auth)/actions"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { signInReturnTo } from "@/lib/sign-in-redirect"
import { AuthSearchParams, socialProviders, type SocialProvider } from "../shared"

export const metadata: Metadata = {
  title: "Sign Up",
}

const providerActions = {
  github: signInWithGithub,
  google: signInWithGoogle,
} satisfies Record<SocialProvider, (formData: FormData) => Promise<never>>

export default function SignUpPage({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense fallback={<SignUpForm actions={providerActions} providers={[]} />}>
          <SignUpGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function SignUpGate({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  await connection()
  const requestHeaders = await headers()
  if (!getEnv().ENABLE_EMAIL_PASSWORD_AUTH) {
    redirect("/signin")
  }

  const auth = getAuth()
  const params = await searchParams
  const error = Array.isArray(params.error) ? params.error[0] : params.error
  const provider = Array.isArray(params.provider) ? params.provider[0] : params.provider
  const returnTo = signInReturnTo(
    Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo
  )
  const session = await auth.api.getSession({
    headers: requestHeaders,
  })
  if (session) {
    redirect(returnTo ?? "/")
  }

  return (
    <SignUpForm
      key={`${error ?? ""}:${provider ?? ""}:${returnTo ?? ""}`}
      actions={providerActions}
      providers={socialProviders()}
      routeError={error}
      routeProvider={provider}
      returnTo={returnTo}
    />
  )
}
