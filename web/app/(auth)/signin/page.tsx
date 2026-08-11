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
    <main
      className="flex min-h-svh w-full items-center justify-center px-4 py-6 md:px-6"
      id="main-content"
    >
      <div className="w-full max-w-md">
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
    </main>
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
  const providers = socialProviders()

  return (
    <SignInForm
      key={`${params.error ?? ""}:${params.provider ?? ""}:${returnTo ?? ""}`}
      actions={providerActions}
      providers={providers}
      routeError={params.error}
      routeProvider={params.provider}
      returnTo={returnTo}
      showPasswordAuth={showPasswordAuth}
      showSignUpLink={showPasswordAuth || providers.length > 0}
    />
  )
}
