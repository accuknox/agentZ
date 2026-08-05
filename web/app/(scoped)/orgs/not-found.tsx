import { AdministrationState } from "@/components/administration"

export default function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <AdministrationState kind="not-found" />
      </div>
    </main>
  )
}
