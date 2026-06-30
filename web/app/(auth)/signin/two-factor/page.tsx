import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { redirect } from "next/navigation"
import { getAuth } from "@/lib/auth"
import { signInReturnTo } from "@/lib/sign-in-redirect"
import { TwoFactorChallenge } from "./two-factor-challenge"

export const metadata: Metadata = {
  title: "Verify Sign In",
}

type TwoFactorPageSearchParams = {
  returnTo?: string | string[]
}

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<TwoFactorPageSearchParams>
}) {
  return (
    <Suspense fallback={<TwoFactorChallengeFallback />}>
      <TwoFactorGate searchParams={searchParams} />
    </Suspense>
  )
}

async function TwoFactorGate({
  searchParams,
}: {
  searchParams: Promise<TwoFactorPageSearchParams>
}) {
  await connection()
  const auth = getAuth()
  const params = await searchParams
  const returnTo =
    signInReturnTo(Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo) ?? "/"
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect(returnTo)
  }

  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <TwoFactorChallenge returnTo={returnTo} />
    </div>
  )
}

function TwoFactorChallengeFallback() {
  return (
    <div className="flex min-h-svh w-full justify-center px-6 py-10 md:px-10 md:py-14">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-8 pt-10">
        <div className="flex items-center justify-center gap-3">
          <div className="bg-muted/20 size-10 rounded-xl" />
          <div className="bg-muted/20 h-8 w-36 rounded-md" />
        </div>
        <div className="flex flex-col gap-5">
          <div className="bg-muted/20 h-9 w-full rounded-lg" />
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="bg-muted/20 h-4 w-24 rounded-md" />
              <div className="bg-muted/20 h-8 w-full rounded-lg" />
            </div>
            <div className="flex items-start gap-3">
              <div className="bg-muted/20 mt-0.5 size-4 rounded-sm" />
              <div className="flex flex-1 flex-col gap-2">
                <div className="bg-muted/20 h-4 w-44 rounded-md" />
                <div className="bg-muted/20 h-4 w-full rounded-md" />
              </div>
            </div>
            <div className="bg-muted/20 h-9 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  )
}
