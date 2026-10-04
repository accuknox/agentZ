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
import { OrganizationAvatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"
import { Alert, AlertDescription } from "@/components/ui/alert"

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
        <main className="flex min-h-svh w-full flex-1 items-center justify-center" role="status">
          <LoaderCircle
            aria-label="Preparing organisation invitation"
            className="size-5 animate-spin text-muted-foreground"
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
      errorMessage = "Sign-in was cancelled. Choose an account when you're ready."
      break
    case "state_mismatch":
    case "state_not_found":
    case "state_invalid":
      errorMessage = "This sign-in attempt expired. Start again."
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
      errorMessage = "We couldn't complete your request. Try again."
  }

  const available = googleAvailable || githubAvailable

  return (
    <main className="relative flex min-h-svh w-full flex-1 items-center justify-center overflow-hidden px-6 py-6">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-72 bg-primary/5 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
      <section className="relative flex w-full max-w-md flex-col items-center text-center">
        <div className="flex items-center gap-2.5">
          <Image src="/agentz-logo.svg" alt="" width={32} height={28} className="h-7 w-8" />
          <span className="text-lg font-semibold tracking-tight">AgentZ</span>
        </div>

        <Image
          src="/invitation.svg"
          alt=""
          width={176}
          height={176}
          className="mt-6 size-40 drop-shadow-sm"
          priority
        />

        <OrganizationAvatar
          className="-mt-2 size-14 bg-background shadow-md ring-4 ring-background"
          logo={org.logo}
          name={org.name}
        />

        <p className="mt-4 text-sm font-semibold text-primary">Organisation invitation</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance">Join {org.name}</h1>
        <p className="mt-2 max-w-sm leading-6 text-balance text-muted-foreground">
          Choose an account to verify your eligibility. We grant access only after the check
          succeeds.
        </p>

        {errorMessage ? (
          <Alert variant="destructive" className="mt-6">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              <p>{errorMessage}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {available ? (
          <div className="mt-5 flex w-full flex-col gap-3">
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
            <p className="mt-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              You will choose an account again before joining.
            </p>
          </div>
        ) : (
          <div className="mt-5 w-full rounded-xl border px-4 py-4 text-sm">
            <p className="font-medium">Social sign up is not available</p>
            <p className="mt-1 text-muted-foreground">
              Ask an Organisation administrator for another way to join.
            </p>
          </div>
        )}

        <Button asChild className="mt-3" variant="ghost">
          <Link href="/signin">
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            Return to sign in
          </Link>
        </Button>
      </section>
    </main>
  )
}
