"use client"

import type { Route } from "next"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  const { orgSlug } = useParams<{ orgSlug: string }>()

  return (
    <main className="flex min-h-80 w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <ErrorState kind="not-found" />
        <div className="flex justify-center">
          <Button asChild>
            <Link href={`/orgs/${encodeURIComponent(orgSlug)}` as Route}>
              Return to organization
            </Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
