import type { Metadata } from "next"
import { Suspense } from "react"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { Mail } from "lucide-react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { getAuth } from "@/lib/auth"
import { PasswordSettings } from "./password-settings"
import { TwoFactorSettings } from "./two-factor-settings"

export const metadata: Metadata = {
  title: "Account",
}

export default function AccountPage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Account</h1>
        </div>
      </div>
      <Suspense fallback={<ProviderSkeleton />}>
        <IdentityProviders />
      </Suspense>
      <Suspense fallback={null}>
        <PasswordGate />
      </Suspense>
      <Suspense fallback={<TwoFactorSkeleton />}>
        <AccountSecurity />
      </Suspense>
    </main>
  )
}

async function IdentityProviders() {
  await connection()
  const auth = getAuth()
  let providers: string[] | undefined
  let errorMessage: string | undefined

  try {
    const accounts = await auth.api.listUserAccounts({
      headers: await headers(),
    })
    providers = [...new Set(accounts.map((account) => account.providerId))]
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load account"
  }

  if (errorMessage || !providers?.length) {
    return <ErrorPanel message={errorMessage ?? "No identity provider found"} />
  }

  return (
    <section className="flex flex-col gap-4 px-4 md:px-6">
      <h2 className="text-lg font-semibold tracking-normal">Sign-in method</h2>
      <div className="flex flex-wrap gap-3">
        {providers.map((provider) => (
          <div
            key={provider}
            className="border-border bg-card text-card-foreground flex h-12 min-w-36 items-center gap-3 rounded-md border px-4 text-sm font-medium"
          >
            {provider === "github" ? (
              <>
                <GitHubLight className="size-5 shrink-0 dark:hidden" />
                <GitHubDark className="hidden size-5 shrink-0 dark:block" />
              </>
            ) : provider === "google" ? (
              <Google className="size-5 shrink-0" />
            ) : (
              <Mail className="size-5 shrink-0" />
            )}
            <span>
              {provider === "credential"
                ? "Email & Password"
                : provider === "github"
                  ? "GitHub"
                  : provider === "google"
                    ? "Google"
                    : provider}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

async function PasswordGate() {
  await connection()
  const auth = getAuth()
  let accounts: Awaited<ReturnType<typeof auth.api.listUserAccounts>> | undefined
  let errorMessage: string | undefined

  try {
    accounts = await auth.api.listUserAccounts({
      headers: await headers(),
    })
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load password settings"
  }

  if (errorMessage) {
    return <ErrorPanel message={errorMessage} />
  }

  if (!accounts?.some((account) => account.providerId === "credential")) {
    return null
  }

  return <PasswordSettings />
}

async function AccountSecurity() {
  await connection()
  const auth = getAuth()
  let enabled = false
  let errorMessage: string | undefined

  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    })

    if (!session) {
      errorMessage = "Unauthorized"
    } else {
      enabled = !!session.user.twoFactorEnabled
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load security settings"
  }

  if (errorMessage) {
    return <ErrorPanel message={errorMessage} />
  }

  return <TwoFactorSettings enabled={enabled} />
}

function ProviderSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 md:px-6">
      <div className="bg-muted/20 h-7 w-44 rounded-md" />
      <div className="bg-muted/20 h-14 w-36 rounded-md" />
    </div>
  )
}

function TwoFactorSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 md:px-6">
      <div className="bg-muted/20 h-7 w-48 rounded-md" />
      <div className="bg-muted/20 h-24 rounded-md" />
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="px-4 md:px-6">
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        {message}
      </div>
    </div>
  )
}
