import type { Metadata } from "next"
import Image from "next/image"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { ArrowRight, CircleAlert } from "lucide-react"
import { acceptInvitationAction } from "@/app/(scoped)/orgs/actions"
import { Button } from "@/components/ui/button"
import { getInvitationAcceptance } from "@/data/members"
import { signInURL } from "@/lib/sign-in-redirect"

export const metadata: Metadata = {
  title: "Organisation Invitation",
}

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  return (
    <Suspense
      fallback={
        <main
          className="flex min-h-svh w-full items-center justify-center px-6 py-12"
          id="main-content"
        >
          <div className="flex w-full max-w-md animate-pulse flex-col items-center text-center">
            <div className="bg-muted h-5 w-32 rounded-md" />
            <Image
              src="/invitation.svg"
              alt=""
              width={176}
              height={176}
              className="mt-10 size-44 opacity-60"
              priority
            />
            <div className="bg-muted mt-8 h-8 w-56 rounded-md" />
            <div className="bg-muted mt-4 h-5 w-72 max-w-full rounded-md" />
            <div className="bg-muted mt-8 h-10 w-full rounded-lg" />
          </div>
        </main>
      }
    >
      <AcceptInvitationContent params={params} searchParams={searchParams} />
    </Suspense>
  )
}

async function AcceptInvitationContent({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams
  const invitation = await getInvitationAcceptance(token)
  if (invitation.kind === "unauthorized") {
    redirect(signInURL({ returnTo: `/accept-invitation/${token}` }))
  }
  if (invitation.kind === "member") {
    redirect(`/orgs/${invitation.slug}`)
  }

  const ready = invitation.kind === "ready"
  const eyebrow = ready ? "You're invited" : "Organisation invitation"
  const title = ready
    ? `Join ${invitation.organizationName}`
    : invitation.kind === "disabled"
      ? "Your membership is disabled"
      : "This invitation is no longer available"
  const description = ready
    ? `${invitation.inviterName} invited you to join ${invitation.organizationName} in AgentZ.`
    : invitation.kind === "disabled"
      ? "An Organisation administrator must restore your membership before you can rejoin."
      : "The link has expired, was cancelled, or has already been accepted."
  const errorMessage =
    ready && error
      ? error === "limit"
        ? "This Organisation has reached its Member limit."
        : "This invitation could not be accepted."
      : undefined

  return (
    <main
      className="flex min-h-svh w-full items-center justify-center px-6 py-12"
      id="main-content"
    >
      <section className="flex w-full max-w-md flex-col items-center text-center">
        <div className="flex items-center gap-2.5">
          <Image src="/agentz-logo.svg" alt="" width={32} height={28} className="h-7 w-8" />
          <span className="text-lg font-semibold tracking-tight">AgentZ</span>
        </div>
        <Image
          src="/invitation.svg"
          alt=""
          width={176}
          height={176}
          className={ready ? "mt-10 size-44" : "mt-10 size-44 opacity-75 grayscale-[20%]"}
          priority
        />
        <p
          className={
            ready
              ? "text-primary mt-8 text-sm font-semibold"
              : "text-muted-foreground mt-8 text-sm font-semibold"
          }
        >
          {eyebrow}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-muted-foreground mt-4 max-w-sm leading-6 text-balance">{description}</p>
        {errorMessage ? (
          <p className="text-destructive mt-6 flex items-center gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {errorMessage}
          </p>
        ) : null}
        {ready ? (
          <form action={acceptInvitationAction.bind(null, token)} className="mt-8 w-full">
            <Button className="h-10 w-full" type="submit">
              Join {invitation.organizationName}
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Button>
          </form>
        ) : null}
      </section>
    </main>
  )
}
