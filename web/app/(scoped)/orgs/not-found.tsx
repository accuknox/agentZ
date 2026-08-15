import { ErrorState } from "@/components/error-state"

export default function NotFound() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <ErrorState kind="not-found" />
      </div>
    </main>
  )
}
