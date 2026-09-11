import { z } from "zod"
import type { SearchParamStringInput } from "@/lib/search-params"
import type { Route } from "next"
import { getEnv } from "@/lib/env"
import { eq } from "drizzle-orm"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { beginGitHubConnection, disconnectGitHub, githubActor } from "@/lib/coding/github"
import { getDB, schema } from "@/db"
import { Button } from "@/components/ui/button"

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
        <h2 className="text-lg font-semibold">GitHub for Coding</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Your account is used for GitHub buttons and repository requests. Agents never receive
          these credentials.
        </p>
      </div>
      {result === "failed" ? (
        <p role="alert" className="text-destructive text-sm">
          GitHub could not connect. Start again and complete authorization in the same signed-in
          session.
        </p>
      ) : null}
      {result === "disconnect_failed" ? (
        <p role="alert" className="text-destructive text-sm">
          GitHub could not confirm revocation. Your connection is still saved. Try disconnecting
          again.
        </p>
      ) : null}
      {result === "connected" ? (
        <p role="status" className="text-sm">
          GitHub connected.
        </p>
      ) : null}
      {connection ? (
        <div className="flex items-center gap-4">
          <span className="text-sm">
            Connected as <strong>{connection.login}</strong>
          </span>
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
              Disconnect GitHub
            </Button>
          </form>
        </div>
      ) : (
        <form
          action={async () => {
            "use server"
            redirect((await beginGitHubConnection()) as Route)
          }}
        >
          <Button disabled={!getEnv().CODING_GITHUB_CLIENT_ID} variant="outline" type="submit">
            Connect GitHub
          </Button>
        </form>
      )}
      {!getEnv().CODING_GITHUB_CLIENT_ID ? (
        <p className="text-muted-foreground text-sm">
          A deployment administrator must configure the Coding GitHub App before accounts can
          connect.
        </p>
      ) : null}
    </section>
  )
}
