import Link from "next/link"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="flex w-full min-w-0 flex-1 items-center justify-center p-4 md:p-6">
      <div className="w-full max-w-2xl">
        <ErrorState kind="not-found" />
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href="/settings/account">Return to account</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
