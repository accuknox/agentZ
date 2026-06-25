import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { LoginForm, type LoginError } from "@/components/login-form"
import type { LoginProvider } from "@/components/login-submit-button"
import { auth } from "@/lib/auth"
import { env } from "@/lib/env"
import { loginReturnTo, loginURL } from "@/lib/login-redirect"
import { firstSearchParam } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Login | ClawArmor - AccuKnox",
}

type LoginSearchParams = {
  error?: LoginError | LoginError[]
  returnTo?: string | string[]
}

async function signInWithGithub(formData: FormData): Promise<never> {
  "use server"

  const returnTo = loginReturnTo(formData.get("returnTo")?.toString())
  const result = await auth.api.signInSocial({
    body: {
      callbackURL: returnTo ?? "/",
      disableRedirect: true,
      errorCallbackURL: loginURL({ returnTo }),
      provider: "github",
    },
    headers: await headers(),
  })

  if (!result.url) {
    redirect(loginURL({ error: "no_callback_url", returnTo }))
  }

  redirect(result.url)
}

async function signInWithGoogle(formData: FormData): Promise<never> {
  "use server"

  const returnTo = loginReturnTo(formData.get("returnTo")?.toString())
  const result = await auth.api.signInSocial({
    body: {
      callbackURL: returnTo ?? "/",
      disableRedirect: true,
      errorCallbackURL: loginURL({ returnTo }),
      provider: "google",
    },
    headers: await headers(),
  })

  if (!result.url) {
    redirect(loginURL({ error: "no_callback_url", returnTo }))
  }

  redirect(result.url)
}

// The set of enabled providers is fixed at module load: env is parsed exactly
// once at boot, so this array is stable across renders and lets the Suspense
// fallback share the same provider list as the gate.
const providers: { id: LoginProvider; action: (formData: FormData) => Promise<never> }[] = []
if (env.GITHUB_CLIENT_ID) {
  providers.push({ id: "github", action: signInWithGithub })
}
if (env.GOOGLE_CLIENT_ID) {
  providers.push({ id: "google", action: signInWithGoogle })
}

export default function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense fallback={<LoginForm providers={providers} />}>
          <LoginGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function LoginGate({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  "use cache: private"

  const params = await searchParams

  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect(loginReturnTo(firstSearchParam(params.returnTo)) ?? "/")
  }

  const error = firstSearchParam(params.error)
  const returnTo = loginReturnTo(firstSearchParam(params.returnTo))

  return <LoginForm providers={providers} error={error} returnTo={returnTo} />
}
