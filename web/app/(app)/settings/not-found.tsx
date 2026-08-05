import Link from "next/link"
import { AdministrationState } from "@/components/administration"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="flex min-w-0 flex-1 p-4 md:p-6">
      <AdministrationState
        actions={
          <Button asChild variant="outline">
            <Link href="/settings/account">Return to Account</Link>
          </Button>
        }
        kind="not-found"
        title="Setting not found"
      />
    </main>
  )
}
