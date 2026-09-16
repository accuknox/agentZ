import { z } from "zod"
import type { SearchParamStringInput } from "@/lib/search-params"
import { getEnv } from "@/lib/env"
import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { beginGitHubConnection, disconnectGitHub, githubActor } from "@/lib/coding/github"
import { getDB, schema } from "@/db"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { GitHubLight, GitHubDark } from "@ridemountainpig/svgl-react"
import { CircleAlert } from "lucide-react"
import { GitHubConnectionButton } from "./github-connection-button"

export async function GitHubConnection({
  searchParams,
}: {
  searchParams: Promise<{ github?: SearchParamStringInput }>
}) {
  const { github: result } = z
    .object({
      github: z.enum(["failed", "disconnect_failed"]).optional().catch(undefined),
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
        <h2 className="text-lg font-semibold">GitHub</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect GitHub to browse repositories, push commits, and open pull requests.
        </p>
      </div>
      {result ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            {result === "disconnect_failed"
              ? "Could not disconnect GitHub. Try again."
              : "Could not connect to GitHub. Try again."}
          </AlertDescription>
        </Alert>
      ) : null}
      {connection ? (
        <div className="bg-card flex w-full max-w-2xl items-center gap-3 rounded-lg p-4">
          <div className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <GitHubLight className="size-5 dark:hidden" aria-hidden="true" />
            <GitHubDark className="hidden size-5 dark:block" aria-hidden="true" />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{connection.login}</p>
          <form
            action={async () => {
              "use server"
              try {
                await disconnectGitHub()
              } catch {
                redirect("/settings/account?github=disconnect_failed")
              }
              revalidatePath("/settings/account")
              redirect("/settings/account")
            }}
          >
            <GitHubConnectionButton connected />
          </form>
        </div>
      ) : (
        <form
          action={async () => {
            "use server"
            redirect(await beginGitHubConnection())
          }}
        >
          <GitHubConnectionButton disabled={!getEnv().CODING_GITHUB_CLIENT_ID} />
        </form>
      )}
      {!getEnv().CODING_GITHUB_CLIENT_ID ? (
        <p className="text-muted-foreground text-sm">
          GitHub connections are not available yet. Contact your administrator to enable them.
        </p>
      ) : null}
    </section>
  )
}
