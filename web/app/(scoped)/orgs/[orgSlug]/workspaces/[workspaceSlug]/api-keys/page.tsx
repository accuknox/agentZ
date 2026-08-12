import type { Route } from "next"
import { redirect } from "next/navigation"

export default function WorkspaceAPIKeysPage() {
  redirect("/settings/api-keys" as Route)
}
