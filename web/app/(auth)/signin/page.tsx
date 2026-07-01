import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import { signInWithGithub, signInWithGoogle } from "@/app/(auth)/actions"
import { SignInForm } from "@/components/auth/sign-in-form"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { signInReturnTo } from "@/lib/sign-in-redirect"
import { AuthSearchParams, socialProviders, type SocialProvider } from "../shared"

export const metadata: Metadata = {
  title: "Sign In | ClawArmor - AccuKnox",
}

const providerActions = {
  github: signInWithGithub,
  google: signInWithGoogle,
} satisfies Record<SocialProvider, (formData: FormData) => Promise<never>>

export default function SignInPage({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  const showPasswordAuth = getEnv().ENABLE_EMAIL_PASSWORD_AUTH

  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense
          fallback={
            <SignInForm
              actions={providerActions}
              providers={[]}
              showPasswordAuth={showPasswordAuth}
              showSignUpLink={showPasswordAuth}
            />
          }
        >
          <SignInGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function SignInGate({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  await connection()
  const auth = getAuth()
  const params = await searchParams
  const error = Array.isArray(params.error) ? params.error[0] : params.error
  const provider = Array.isArray(params.provider) ? params.provider[0] : params.provider
  const returnTo = signInReturnTo(
    Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo
  )
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect(returnTo ?? "/")
  }

  const showPasswordAuth = getEnv().ENABLE_EMAIL_PASSWORD_AUTH

  return (
    <SignInForm
      key={`${error ?? ""}:${provider ?? ""}:${returnTo ?? ""}`}
      actions={providerActions}
      providers={socialProviders()}
      routeError={error}
      routeProvider={provider}
      returnTo={returnTo}
      showPasswordAuth={showPasswordAuth}
      showSignUpLink={showPasswordAuth}
    />
  )
}
