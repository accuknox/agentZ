import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { LoginForm } from "@/components/login-form"
import { auth } from "@/lib/auth"

export const metadata: Metadata = {
  title: "Login | ClawArmor - AccuKnox",
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>
}) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={<LoginForm />}>
          <LoginGate searchParams={searchParams} />
        </Suspense>
      </div>
    </div>
  )
}

async function LoginGate({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>
}) {
  "use cache: private"

  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect("/")
  }

  const params = await searchParams
  const error = Array.isArray(params.error) ? params.error[0] : params.error

  return <LoginForm error={error} />
}
