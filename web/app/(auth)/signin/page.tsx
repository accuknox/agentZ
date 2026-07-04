import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { signInWithGithub, signInWithGoogle } from "@/app/(auth)/actions"
import { SignInForm } from "@/components/auth/sign-in-form"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { signInReturnTo } from "@/lib/sign-in-redirect"
import {
  authSearchParamsSchema,
  socialProviders,
  type AuthSearchParams,
  type SocialProvider,
} from "../shared"

export const metadata: Metadata = {
  title: "Sign In",
}

const providerActions = {
  github: signInWithGithub,
  google: signInWithGoogle,
} satisfies Record<SocialProvider, (formData: FormData) => Promise<never>>

export default function SignInPage({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense
          fallback={
            <SignInForm
              actions={providerActions}
              providers={[]}
              showPasswordAuth={false}
              showSignUpLink={false}
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

  const showPasswordAuth = getEnv().ENABLE_EMAIL_PASSWORD_AUTH

  return (
    <SignInForm
      key={`${params.error ?? ""}:${params.provider ?? ""}:${returnTo ?? ""}`}
      actions={providerActions}
      providers={socialProviders()}
      routeError={params.error}
      routeProvider={params.provider}
      returnTo={returnTo}
      showPasswordAuth={showPasswordAuth}
      showSignUpLink={showPasswordAuth}
    />
  )
}
