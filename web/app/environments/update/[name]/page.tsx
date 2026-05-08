import { notFound } from "next/navigation"
import { listEnvironmentsCachedQuery } from "@/data/environment.queries"
import { EnvironmentWizard } from "../../wizard"

export default async function UpdateEnvironmentPage({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params
  const result = await listEnvironmentsCachedQuery({ limit: 200 })

  if (result.error || !result.environments) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {result.error?.message ?? "Failed to load environment"}
      </div>
    )
  }

  const env = result.environments.find((e) => e.name === name)
  if (!env) {
    notFound()
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">Update environment</h1>
      </div>
      <EnvironmentWizard
        mode="update"
        initialName={env.name}
        initialPackages={env.packages ?? []}
        initialAllowedHosts={env.allowed_hosts ?? []}
      />
    </main>
  )
}
