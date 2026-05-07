import { EnvironmentWizard } from "../wizard"

export default function NewEnvironmentPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:px-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">New environment</h1>
      </div>
      <EnvironmentWizard mode="create" />
    </main>
  )
}
