import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { LoginForm, type LoginError } from "@/components/login-form"
import { auth } from "@/lib/auth"
import { firstSearchParam } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Login | ClawArmor - AccuKnox",
}

async function signInWithGithub(): Promise<never> {
  "use server"

  const result = await auth.api.signInSocial({
    body: {
      callbackURL: "/",
      disableRedirect: true,
      errorCallbackURL: "/login",
      provider: "github",
    },
    headers: await headers(),
  })

  if (!result.url) {
    redirect("/login?error=no_callback_url")
  }

  redirect(result.url)
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: LoginError | LoginError[] }>
}) {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="w-full max-w-xl">
        <Suspense fallback={<LoginForm action={signInWithGithub} />}>
          <LoginGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function LoginGate({
  searchParams,
}: {
  searchParams: Promise<{ error?: LoginError | LoginError[] }>
}) {
  "use cache: private"

  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect("/")
  }

  const params = await searchParams
  const error = firstSearchParam(params.error)

  return <LoginForm action={signInWithGithub} error={error} />
}
