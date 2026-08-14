import type { Route } from "next"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { eq } from "drizzle-orm"
import { ArrowLeft, Building2, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react"
import Link from "next/link"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { Suspense } from "react"
import { Button } from "@/components/ui/button"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export default function JoinOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; provider: string }>
  searchParams: Promise<{ error?: SearchParamStringInput }>
}) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-svh w-full items-center justify-center" role="status">
          <LoaderCircle
            aria-label="Preparing organisation invitation"
            className="size-5 animate-spin"
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
  params: Promise<{ orgSlug: string; provider: string }>
  searchParams: Promise<{ error?: SearchParamStringInput }>
}) {
  const { orgSlug, provider } = await params
  if (provider !== "github" && provider !== "google") {
    notFound()
  }

  const [organization] = await getDB()
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
    })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, orgSlug))
    .limit(1)
  if (!organization) {
    notFound()
  }

  const { id: organizationId, name: organizationName, slug: organizationSlug } = organization
  const error = searchParamStringSchema.parse((await searchParams).error)
  const providerName = provider === "google" ? "Google" : "GitHub"

  async function joinOrganization() {
    "use server"

    const result = await getAuth().api.signInSocial({
      body: {
        additionalData: {
          agentzEnrollment: "social",
          organizationId,
          provider,
        },
        callbackURL: `/orgs/${organizationSlug}`,
        disableRedirect: true,
        errorCallbackURL: `/join/${organizationSlug}/${provider}`,
        provider,
        requestSignUp: true,
      },
      headers: await headers(),
    })
    if (!result.url) {
      redirect("/signin?error=no_callback_url")
    }

    redirect(result.url as Route)
  }

  if (error) {
    const title = error === "state_mismatch" ? "Sign-in expired" : "Unable to join"
    const description =
      error === "unable_to_get_user_info"
        ? `This ${providerName} account does not meet the organisation's admission rules.`
        : error === "state_mismatch"
          ? "We couldn’t verify this sign-in attempt. Start again to continue."
          : "The sign-in attempt could not be completed. Start again or return to sign in."

    return (
      <main className="flex min-h-svh w-full items-center justify-center p-6 text-center">
        <section className="flex w-full max-w-sm flex-col items-center" role="alert">
          <div className="bg-destructive/10 text-destructive mb-5 grid size-11 place-items-center rounded-full">
            <CircleAlert aria-hidden className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground mt-2 text-sm/relaxed text-pretty">{description}</p>
          <div className="mt-5 flex items-center gap-2 text-sm">
            <Building2 aria-hidden className="text-muted-foreground size-4" />
            <span className="text-muted-foreground">Organisation</span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <span className="font-medium">{organizationName}</span>
          </div>
          <div className="mt-7 flex w-full flex-col gap-2">
            <form action={joinOrganization}>
              <Button className="w-full" type="submit">
                <RotateCcw aria-hidden data-icon="inline-start" />
                Try {providerName} again
              </Button>
            </form>
            <Button asChild className="w-full" variant="ghost">
              <Link href="/signin">
                <ArrowLeft aria-hidden data-icon="inline-start" />
                Return to sign in
              </Link>
            </Button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6 text-center">
      <section className="flex w-full max-w-sm flex-col items-center">
        <div className="bg-muted mb-5 grid size-11 place-items-center rounded-full">
          <Building2 aria-hidden className="size-5" />
        </div>
        <p className="text-muted-foreground text-sm">Organisation invitation</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{organizationName}</h1>
        <p className="text-muted-foreground mt-3 text-sm/relaxed text-pretty">
          Continue with {providerName} to verify your account and request access.
        </p>
        <form action={joinOrganization} className="mt-7 w-full">
          <Button className="w-full gap-3" size="lg" type="submit" variant="outline">
            {provider === "google" ? (
              <Google aria-hidden data-icon="inline-start" />
            ) : (
              <>
                <GitHubLight aria-hidden className="dark:hidden" data-icon="inline-start" />
                <GitHubDark aria-hidden className="hidden dark:block" data-icon="inline-start" />
              </>
            )}
            Continue with {providerName}
          </Button>
        </form>
      </section>
    </main>
  )
}
