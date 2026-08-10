import Link from "next/link"
import type { Route } from "next"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function TeamDelete({ orgSlug, teamId }: { orgSlug: string; teamId: string }) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete Team</CardTitle>
        <CardDescription>
          Review access loss, owned Agents, affected credentials, and transfer opportunities before
          deleting this Team.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="destructive">
          <Link href={`/orgs/${orgSlug}/teams/${teamId}/delete` as Route}>
            <Trash2 />
            Review Deletion
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
