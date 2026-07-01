import type { Metadata } from "next"
import { headers } from "next/headers"
import { ChatShell } from "@/components/blocks/chat/chat-shell"
import { getAuth } from "@/lib/auth"

type ChatPageParams = {
  name: string
}

type ChatPageSearchParams = {
  draft?: string
}

export async function generateMetadata({
  params,
}: {
  params: Promise<ChatPageParams>
}): Promise<Metadata> {
  const { name } = await params

  return {
    title: `New Session: ${name}`,
  }
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<ChatPageParams>
  searchParams: Promise<ChatPageSearchParams>
}) {
  const auth = getAuth()
  const requestHeaders = await headers()
  const [routeParams, resolvedSearchParams, session] = await Promise.all([
    params,
    searchParams,
    auth.api.getSession({
      headers: requestHeaders,
    }),
  ])
  const { name } = routeParams
  const { draft } = resolvedSearchParams
  const firstName =
    session?.user.name?.trim().split(/\s+/, 1)[0] ||
    session?.user.email.split("@")[0]?.trim() ||
    undefined

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-0">
      <ChatShell agentName={name} draftKey={draft} firstName={firstName} />
    </main>
  )
}
