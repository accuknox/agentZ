import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import { LoginForm, type LoginError, type LoginProvider } from "@/components/login-form"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { loginReturnTo, loginURL } from "@/lib/login-redirect"

export const metadata: Metadata = {
  title: "Login | ClawArmor - AccuKnox",
}

type LoginSearchParams = {
  error?: LoginError | LoginError[]
  returnTo?: string | string[]
}

async function signInWithProvider(provider: LoginProvider, formData: FormData): Promise<never> {
  "use server"

  const auth = getAuth()
  const returnTo = loginReturnTo(formData.get("returnTo")?.toString())
  const result = await auth.api.signInSocial({
    body: {
      callbackURL: returnTo ?? "/",
      disableRedirect: true,
      errorCallbackURL: loginURL({ returnTo }),
      provider,
    },
    headers: await headers(),
  })

  if (!result.url) {
    redirect(loginURL({ error: "no_callback_url", returnTo }))
  }

  redirect(result.url)
}

const providerActions = {
  github: signInWithProvider.bind(null, "github"),
  google: signInWithProvider.bind(null, "google"),
} satisfies Record<LoginProvider, (formData: FormData) => Promise<never>>

function loginProviders(): Array<{
  id: LoginProvider
  action: (formData: FormData) => Promise<never>
}> {
  const env = getEnv()
  const providers: Array<{
    id: LoginProvider
    action: (formData: FormData) => Promise<never>
  }> = []

  if (env.GITHUB_CLIENT_ID) {
    providers.push({ id: "github", action: providerActions.github })
  }
  if (env.GOOGLE_CLIENT_ID) {
    providers.push({ id: "google", action: providerActions.google })
  }

  return providers
}

export default function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense fallback={<LoginForm providers={[]} />}>
          <LoginGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function LoginGate({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  await connection()
  const auth = getAuth()
  const params = await searchParams

  const session = await auth.api.getSession({
    headers: await headers(),
  })
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo

  if (session) {
    redirect(loginReturnTo(returnToParam) ?? "/")
  }

  const error = Array.isArray(params.error) ? params.error[0] : params.error
  const returnTo = loginReturnTo(returnToParam)

  return <LoginForm providers={loginProviders()} error={error} returnTo={returnTo} />
}
