import type { Metadata } from "next"
import { Suspense } from "react"
import * as z from "zod"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { Mail } from "lucide-react"
import { headers } from "next/headers"
import { authErrorSchema, socialProviderSchema, type AuthError } from "@/app/(auth)/shared"
import { getAuth } from "@/lib/auth"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { PasswordSettings } from "./password-settings"
import { TwoFactorSettings } from "./two-factor-settings"

export const metadata: Metadata = {
  title: "Account",
}

const accountManage2FASchema = z.enum(["disable", "enable"])

const accountSearchParamsSchema = z.object({
  error: searchParamStringSchema.pipe(authErrorSchema.optional()).catch(undefined),
  manage2fa: searchParamStringSchema.pipe(accountManage2FASchema.optional()).catch(undefined),
  provider: searchParamStringSchema.pipe(socialProviderSchema.optional()).catch(undefined),
})

type AccountSearchParams = {
  error?: SearchParamStringInput
  manage2fa?: SearchParamStringInput
  provider?: SearchParamStringInput
}

export default function AccountPage({
  searchParams,
}: {
  searchParams: Promise<AccountSearchParams>
}) {
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
        <AccountSecurity searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function IdentityProviders() {
  const requestHeaders = await headers()
  const auth = getAuth()
  let providers: string[] | undefined
  let errorMessage: string | undefined

  try {
    const accounts = await auth.api.listUserAccounts({
      headers: requestHeaders,
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
  const requestHeaders = await headers()
  const auth = getAuth()
  let accounts: Awaited<ReturnType<typeof auth.api.listUserAccounts>> | undefined
  let errorMessage: string | undefined

  try {
    accounts = await auth.api.listUserAccounts({
      headers: requestHeaders,
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

async function AccountSecurity({ searchParams }: { searchParams: Promise<AccountSearchParams> }) {
  const requestHeaders = await headers()
  const auth = getAuth()
  let enabled = false
  let email = ""
  let errorMessage: string | undefined
  let intent: z.infer<typeof accountManage2FASchema> | undefined
  let provider: "credential" | "github" | "google" = "credential"
  let routeError: AuthError | undefined
  const params = accountSearchParamsSchema.parse(await searchParams)

  try {
    const session = await auth.api.getSession({
      headers: requestHeaders,
      query: {
        disableCookieCache: true,
      },
    })

    if (!session) {
      errorMessage = "Unauthorized"
    } else {
      const accounts = await auth.api.listUserAccounts({
        headers: requestHeaders,
      })
      email = session.user.email
      enabled = !!session.user.twoFactorEnabled
      if (!accounts.some((account) => account.providerId === "credential")) {
        const currentProvider = accounts[0]?.providerId
        if (currentProvider === "github" || currentProvider === "google") {
          provider = currentProvider
        }
      }
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load security settings"
  }

  if (errorMessage) {
    return <ErrorPanel message={errorMessage} />
  }

  if (params.manage2fa) {
    intent = params.manage2fa
  }
  if (params.provider) {
    provider = params.provider
  }
  routeError = params.error

  return (
    <TwoFactorSettings
      email={email}
      enabled={enabled}
      intent={intent}
      provider={provider}
      routeError={routeError}
    />
  )
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
