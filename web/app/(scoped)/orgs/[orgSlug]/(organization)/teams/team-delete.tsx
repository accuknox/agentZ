import Link from "next/link"
import type { Route } from "next"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"

export function TeamDelete({ orgSlug, teamId }: { orgSlug: string; teamId: string }) {
  return (
    <section className="grid gap-3 px-4 pb-6 md:px-6">
      <h2 className="text-lg font-medium">Delete team</h2>
      <div>
        <Button asChild variant="destructive">
          <Link href={`/orgs/${orgSlug}/teams/${teamId}/delete` as Route}>
            <Trash2 />
            Review deletion
          </Link>
        </Button>
      </div>
    </section>
  )
}
