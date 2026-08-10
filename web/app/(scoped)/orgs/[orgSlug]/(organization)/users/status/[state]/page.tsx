import { notFound } from "next/navigation"
import UsersPage from "../../page"

export default function UserStatePage({
  params,
}: {
  params: Promise<{ orgSlug: string; state: string }>
}) {
  const state = params.then(({ state }) => {
    if (state !== "active" && state !== "invited" && state !== "disabled") {
      notFound()
    }
    return { tab: state }
  })

  return <UsersPage params={params} searchParams={state} />
}
