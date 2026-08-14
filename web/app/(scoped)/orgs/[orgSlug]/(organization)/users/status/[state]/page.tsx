import { notFound } from "next/navigation"
import UsersPage from "../../page"

export default function UserStatePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; state: string }>
  searchParams: Promise<{ page_token?: string }>
}) {
  const state = Promise.all([params, searchParams]).then(([{ state }, search]) => {
    if (state !== "active" && state !== "invited" && state !== "disabled") {
      notFound()
    }
    return { ...search, tab: state }
  })

  return <UsersPage params={params} searchParams={state} />
}
