import { randomInt } from "node:crypto"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { getAuth } from "@/lib/auth"

type NewSessionPageParams = Promise<{
  name: string
}>

type NewSessionSearchParams = Promise<{
  draft?: string | string[]
  [key: string]: string | string[] | undefined
}>

type NewSessionPageProps = {
  params: NewSessionPageParams
  searchParams: NewSessionSearchParams
}

export async function generateMetadata({
  params,
}: Pick<NewSessionPageProps, "params">): Promise<Metadata> {
  const { name } = await params

  return {
    title: `New Session: ${name}`,
  }
}

export default async function ChatPage({ params, searchParams }: NewSessionPageProps) {
  const requestHeaders = await headers()
  const auth = getAuth()
  const [routeParams, resolvedSearchParams, session] = await Promise.all([
    params,
    searchParams,
    auth.api.getSession({
      headers: requestHeaders,
    }),
  ])
  const { name } = routeParams
  const draft =
    typeof resolvedSearchParams.draft === "string" ? resolvedSearchParams.draft : undefined
  const firstName =
    session?.user.name?.trim().split(/\s+/, 1)[0] ||
    session?.user.email.split("@")[0]?.trim() ||
    undefined
  const greetingIndex = randomInt(10)

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell
        agentName={name}
        draftKey={draft}
        firstName={firstName}
        greetingIndex={greetingIndex}
      />
    </main>
  )
}
