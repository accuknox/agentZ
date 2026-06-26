import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { connection } from "next/server"
import { getAuth, type Auth } from "@/lib/auth"
import { deleteSessionFormAction } from "@/data/session.actions"
import { SessionsTable } from "./sessions-table"

export const metadata: Metadata = {
  title: "Sessions",
}

export default function SessionsPage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex items-start justify-between gap-4 px-4 pt-4 md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Sessions</h1>
        </div>
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <Sessions />
      </Suspense>
    </main>
  )
}

async function Sessions() {
  await connection()
  const auth = getAuth()
  const requestHeaders = await headers()
  let currentToken: string | undefined
  let sessions: Awaited<ReturnType<Auth["api"]["listSessions"]>> | undefined
  let errorMessage: string | undefined

  try {
    const [currentSession, listedSessions] = await Promise.all([
      auth.api.getSession({
        headers: requestHeaders,
      }),
      auth.api.listSessions({
        headers: requestHeaders,
      }),
    ])

    if (!currentSession) {
      errorMessage = "Unauthorized"
    } else {
      currentToken = currentSession.session.token
      sessions = listedSessions.toSorted((x, y) => {
        if (x.token === currentSession.session.token) {
          return -1
        }
        if (y.token === currentSession.session.token) {
          return 1
        }
        return y.updatedAt.getTime() - x.updatedAt.getTime()
      })
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load sessions"
  }

  if (errorMessage || !currentToken || !sessions) {
    return <ErrorPanel message={errorMessage ?? "Failed to load sessions"} />
  }

  return (
    <SessionsTable
      currentToken={currentToken}
      deleteSessionAction={deleteSessionFormAction}
      sessions={sessions}
    />
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 md:px-6">
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
      <div className="bg-muted/20 h-10 rounded-md" />
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
