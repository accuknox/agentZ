import Link from "next/link"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="flex min-h-svh w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <ErrorState kind="not-found" />
        <div className="flex justify-center">
          <Button asChild>
            <Link href="/">Return home</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
