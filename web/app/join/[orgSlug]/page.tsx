import type { Route } from "next"
import Image from "next/image"
import Link from "next/link"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { eq } from "drizzle-orm"
import { ArrowLeft, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"
import * as z from "zod"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata = { title: "Join organisation" }

const providerSchema = z.enum(["github", "google"])

export default function JoinOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{
    error?: SearchParamStringInput
  }>
}) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-svh items-center justify-center" role="status">
          <LoaderCircle
            aria-label="Preparing organisation invitation"
            className="text-muted-foreground size-5 animate-spin"
          />
        </main>
      }
    >
      <JoinOrganizationContent params={params} searchParams={searchParams} />
    </Suspense>
  )
}

async function JoinOrganizationContent({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{
    error?: SearchParamStringInput
  }>
}) {
  const { orgSlug } = await params
  const db = getDB()
  const [organization] = await db
    .select({
      id: schema.organizations.id,
      logo: schema.organizations.logo,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug))
    .limit(1)
  if (!organization) {
    notFound()
  }
  const org = organization

  const [policy, googleRules, githubRules] = await Promise.all([
    db
      .select({
        enabled: schema.socialAdmissionPolicies.enabled,
        githubEnabled: schema.socialAdmissionPolicies.githubEnabled,
        googleEnabled: schema.socialAdmissionPolicies.googleEnabled,
      })
      .from(schema.socialAdmissionPolicies)
      .where(eq(schema.socialAdmissionPolicies.organizationId, org.id))
      .limit(1),
    db.$count(
      schema.socialAdmissionGoogleDomains,
      eq(schema.socialAdmissionGoogleDomains.organizationId, org.id)
    ),
    db.$count(
      schema.socialAdmissionGithubRules,
      eq(schema.socialAdmissionGithubRules.organizationId, org.id)
    ),
  ])
  const env = getEnv()
  const googleAvailable =
    policy[0]?.enabled === true &&
    policy[0].googleEnabled &&
    googleRules > 0 &&
    env.GOOGLE_CLIENT_ID !== undefined
  const githubAvailable =
    policy[0]?.enabled === true &&
    policy[0].githubEnabled &&
    githubRules > 0 &&
    env.GITHUB_CLIENT_ID !== undefined
  const parsedSearchParams = await searchParams
  const error = searchParamStringSchema.parse(parsedSearchParams.error)

  async function joinOrganization(input: string) {
    "use server"

    const provider = providerSchema.parse(input)
    const db = getDB()
    const [policy, rules] = await Promise.all([
      db
        .select({
          enabled: schema.socialAdmissionPolicies.enabled,
          githubEnabled: schema.socialAdmissionPolicies.githubEnabled,
          googleEnabled: schema.socialAdmissionPolicies.googleEnabled,
        })
        .from(schema.socialAdmissionPolicies)
        .where(eq(schema.socialAdmissionPolicies.organizationId, org.id))
        .limit(1),
      provider === "google"
        ? db.$count(
            schema.socialAdmissionGoogleDomains,
            eq(schema.socialAdmissionGoogleDomains.organizationId, org.id)
          )
        : db.$count(
            schema.socialAdmissionGithubRules,
            eq(schema.socialAdmissionGithubRules.organizationId, org.id)
          ),
    ])
    const env = getEnv()
    const available =
      policy[0]?.enabled === true &&
      rules > 0 &&
      (provider === "google"
        ? policy[0].googleEnabled && env.GOOGLE_CLIENT_ID !== undefined
        : policy[0].githubEnabled && env.GITHUB_CLIENT_ID !== undefined)
    if (!available) {
      redirect(`/join/${org.slug}?error=provider_unavailable` as Route)
    }

    const result = await getAuth()
      .api.signInSocial({
        body: {
          additionalData: {
            agentzEnrollment: "social",
            organizationId: org.id,
            provider,
          },
          callbackURL: `/orgs/${org.slug}`,
          disableRedirect: true,
          errorCallbackURL: `/join/${org.slug}`,
          provider,
          requestSignUp: true,
        },
        headers: await headers(),
      })
      .catch((error: unknown) => {
        console.error("social admission OAuth initiation failed", error)
        return undefined
      })
    if (!result?.url) {
      redirect(`/join/${org.slug}?error=provider_unavailable` as Route)
    }

    redirect(result.url as Route)
  }

  let errorMessage: string | undefined
  switch (error) {
    case "access_denied":
      errorMessage = "Sign-in was cancelled. Choose an account when you’re ready."
      break
    case "state_mismatch":
    case "state_not_found":
    case "state_invalid":
      errorMessage = "This sign-in attempt expired. Please start again."
      break
    case "unable_to_get_user_info":
      errorMessage = "This account is not eligible to join this Organisation."
      break
    case "membership_limit":
      errorMessage = "This Organisation has reached its Member limit."
      break
    case "membership_disabled":
      errorMessage =
        "Your Membership is disabled. Contact an Organisation administrator before joining."
      break
    case "provider_unavailable":
    case "oauth_provider_not_found":
      errorMessage = "This sign-in provider is temporarily unavailable."
      break
    case undefined:
      break
    default:
      errorMessage = "We couldn’t complete your request. Please try again."
  }

  const initials = org.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("")
  const available = googleAvailable || githubAvailable

  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden px-6 py-12">
      <div
        aria-hidden="true"
        className="bg-primary/5 absolute inset-x-0 top-0 h-72 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
      <section className="relative flex w-full max-w-md flex-col items-center text-center">
        <div className="flex items-center gap-2.5">
          <Image src="/emblem.svg" alt="" width={28} height={28} className="size-7" />
          <span className="text-lg font-semibold tracking-tight">AccuKnox AgentZ</span>
        </div>

        <Image
          src="/invitation.svg"
          alt=""
          width={176}
          height={176}
          className="mt-8 size-40 drop-shadow-sm"
          priority
        />

        <Avatar className="bg-background ring-background -mt-2 size-14 shadow-md ring-4">
          <AvatarImage alt={org.name} src={org.logo ?? undefined} />
          <AvatarFallback className="bg-primary/10 text-primary text-base font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>

        <p className="text-primary mt-5 text-sm font-semibold">Organisation invitation</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance">Join {org.name}</h1>
        <p className="text-muted-foreground mt-3 max-w-sm leading-6 text-balance">
          Choose an account to verify that you’re eligible. Your access is granted only after
          verification succeeds.
        </p>

        {errorMessage ? (
          <div
            className="border-destructive/20 bg-destructive/5 text-destructive mt-6 flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm"
            role="alert"
          >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>{errorMessage}</p>
          </div>
        ) : null}

        {available ? (
          <div className="mt-7 flex w-full flex-col gap-3">
            {googleAvailable ? (
              <form action={joinOrganization.bind(null, "google")}>
                <Button className="h-11 w-full gap-3" type="submit" variant="outline">
                  <Google aria-hidden="true" className="size-4.5" />
                  Continue with Google
                </Button>
              </form>
            ) : null}
            {githubAvailable ? (
              <form action={joinOrganization.bind(null, "github")}>
                <Button className="h-11 w-full gap-3" type="submit" variant="outline">
                  <GitHubLight aria-hidden="true" className="size-4.5 dark:hidden" />
                  <GitHubDark aria-hidden="true" className="hidden size-4.5 dark:block" />
                  Continue with GitHub
                </Button>
              </form>
            ) : null}
            <p className="text-muted-foreground mt-1 flex items-center justify-center gap-1.5 text-xs">
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              You’ll choose an account again before joining.
            </p>
          </div>
        ) : (
          <div className="mt-7 w-full rounded-xl border px-4 py-4 text-sm">
            <p className="font-medium">Social sign up is not available</p>
            <p className="text-muted-foreground mt-1">
              Ask an Organisation administrator for another way to join.
            </p>
          </div>
        )}

        <Button asChild className="mt-5" variant="ghost">
          <Link href="/signin">
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            Return to sign in
          </Link>
        </Button>
      </section>
    </main>
  )
}
