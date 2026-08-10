import { AdministrationState } from "@/components/administration"
import { getSocialAdmission } from "@/data/members"
import { SocialAdmissionForm } from "./social-admission-form"

export default async function SocialAdmissionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const data = await getSocialAdmission(orgSlug)
  if (!data) {
    return <AdministrationState kind="forbidden" />
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Social Admission</h2>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Configure opt-in Google and GitHub admission without exposing direct member insertion.
          Explicit Invitations bypass these rules while still enforcing email equality.
        </p>
      </div>
      <SocialAdmissionForm data={data} orgSlug={orgSlug} />
    </div>
  )
}
