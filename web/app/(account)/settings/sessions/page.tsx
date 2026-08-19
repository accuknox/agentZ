import type { Metadata } from "next"
import { Suspense } from "react"
import { headers } from "next/headers"
import { and, asc, desc, eq, gt } from "drizzle-orm"
import * as z from "zod"
import { getAuth } from "@/lib/auth"
import { getDB, schema } from "@/db"
import { deleteSessionFormAction } from "@/data/session.actions"
import { SessionsTable } from "./sessions-table"
import { searchParamStringSchema, type SearchParamStringInput } from "@/lib/search-params"

export const metadata: Metadata = {
  title: "Sessions",
}

const searchSchema = z.object({
  sort_by: searchParamStringSchema.pipe(z.enum(["created_at", "updated_at"]).default("updated_at")),
  sort_order: searchParamStringSchema.pipe(z.enum(["asc", "desc"]).default("desc")),
})

type SearchParams = {
  sort_by?: SearchParamStringInput
  sort_order?: SearchParamStringInput
}

export default function SessionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6 p-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Sessions</h1>
        </div>
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <Sessions searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function Sessions({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [requestHeaders, search] = await Promise.all([headers(), searchParams])
  const sorting = searchSchema.parse(search)
  const auth = getAuth()
  let currentToken: string | undefined
  let sessions: (typeof schema.sessions.$inferSelect)[] | undefined
  let errorMessage: string | undefined

  try {
    const currentSession = await auth.api.getSession({ headers: requestHeaders })

    if (!currentSession) {
      errorMessage = "Unauthorized"
    } else {
      currentToken = currentSession.session.token
      const column =
        sorting.sort_by === "created_at" ? schema.sessions.createdAt : schema.sessions.updatedAt
      const order = sorting.sort_order === "asc" ? asc(column) : desc(column)
      sessions = await getDB()
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, currentSession.user.id),
            gt(schema.sessions.expiresAt, new Date())
          )
        )
        .orderBy(desc(eq(schema.sessions.token, currentToken)), order, asc(schema.sessions.id))
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
      sortBy={sorting.sort_by}
      sortOrder={sorting.sort_order}
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
