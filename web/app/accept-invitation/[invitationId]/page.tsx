import { redirect } from "next/navigation"
import { Suspense } from "react"
import { acceptInvitationAction } from "@/app/(scoped)/orgs/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getAuth } from "@/lib/auth"
import { signInURL } from "@/lib/sign-in-redirect"
import { headers } from "next/headers"

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ invitationId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  return (
    <Suspense fallback={<AcceptInvitationShell />}>
      <AcceptInvitationContent params={params} searchParams={searchParams} />
    </Suspense>
  )
}

async function AcceptInvitationContent({
  params,
  searchParams,
}: {
  params: Promise<{ invitationId: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { invitationId } = await params
  const { error } = await searchParams
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) {
    redirect(signInURL({ returnTo: `/accept-invitation/${invitationId}` }))
  }

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Accept Organisation Invitation</CardTitle>
          <CardDescription>
            This bearer link is valid only for the invited email address. Email/password acceptance
            does not require email verification, which means control of this signed-in email account
            is the proof used here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={acceptInvitationAction.bind(null, invitationId)} className="grid gap-4">
            {error ? (
              <p className="text-destructive rounded-md border p-3 text-sm">
                {invitationError(error)}
              </p>
            ) : null}
            <Button type="submit">Accept Invitation</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

function AcceptInvitationShell() {
  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Accept Organisation Invitation</CardTitle>
          <CardDescription>Loading invitation state.</CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}

function invitationError(error: string) {
  switch (error) {
    case "email-mismatch":
      return "Sign in with the exact invited email address to accept this Invitation."
    case "not-found":
      return "This Invitation is expired, cancelled, replaced, or already accepted."
    case "disabled":
      return "This Organisation Membership is disabled and cannot be restored by Invitation."
    default:
      return "The Invitation could not be accepted."
  }
}
