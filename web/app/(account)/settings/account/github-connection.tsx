import { z } from "zod"
import type { SearchParamStringInput } from "@/lib/search-params"
import { getEnv } from "@/lib/env"
import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { beginGitHubConnection, disconnectGitHub, githubActor } from "@/lib/coding/github"
import { getDB, schema } from "@/db"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { GitHubLight, GitHubDark } from "@ridemountainpig/svgl-react"
import { Badge } from "@/components/ui/badge"
import { CircleAlert, Check, Unplug } from "lucide-react"

export async function GitHubConnection({
  searchParams,
}: {
  searchParams: Promise<{ github?: SearchParamStringInput }>
}) {
  const { github: result } = z
    .object({
      github: z.enum(["connected", "failed", "disconnect_failed"]).optional().catch(undefined),
    })
    .parse(await searchParams)
  const actor = await githubActor()
  const [connection] = await getDB()
    .select({ login: schema.githubConnections.login })
    .from(schema.githubConnections)
    .where(eq(schema.githubConnections.userId, actor.user.id))
  return (
    <section className="flex flex-col gap-4 px-4 md:px-6">
      <div>
        <h2 className="text-lg font-semibold">GitHub for coding</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect GitHub to browse repositories, push commits, and open pull requests.
        </p>
      </div>
      {result === "failed" ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            GitHub could not connect. Start again and complete authorization in the same signed-in
            session.
          </AlertDescription>
        </Alert>
      ) : null}
      {result === "disconnect_failed" ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            GitHub could not confirm revocation. Your connection is still saved. Try disconnecting
            again.
          </AlertDescription>
        </Alert>
      ) : null}
      {result === "connected" ? (
        <p role="status" className="text-primary flex items-center gap-2 text-sm">
          <Check className="size-4" aria-hidden="true" />
          GitHub connected.
        </p>
      ) : null}
      {connection ? (
        <div className="bg-card flex flex-wrap items-center gap-3 rounded-lg border p-4">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <GitHubLight className="size-5 dark:hidden" aria-hidden="true" />
            <GitHubDark className="hidden size-5 dark:block" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{connection.login}</p>
            <Badge variant="successPlain">Connected</Badge>
          </div>
          <form
            action={async () => {
              "use server"
              try {
                await disconnectGitHub()
              } catch {
                redirect("/settings/account?github=disconnect_failed")
              }
              revalidatePath("/settings/account")
            }}
          >
            <Button variant="outline" type="submit">
              <Unplug data-icon="inline-start" />
              Disconnect GitHub
            </Button>
          </form>
        </div>
      ) : (
        <form
          action={async () => {
            "use server"
            redirect(await beginGitHubConnection())
          }}
        >
          <Button disabled={!getEnv().CODING_GITHUB_CLIENT_ID} variant="outline" type="submit">
            <GitHubLight data-icon="inline-start" className="dark:hidden" />
            <GitHubDark data-icon="inline-start" className="hidden dark:block" />
            Connect GitHub
          </Button>
        </form>
      )}
      {!getEnv().CODING_GITHUB_CLIENT_ID ? (
        <p className="text-muted-foreground text-sm">
          Your administrator must configure the Coding GitHub App before accounts can connect.
        </p>
      ) : null}
    </section>
  )
}
