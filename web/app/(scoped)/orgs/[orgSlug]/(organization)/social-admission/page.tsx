import { AdministrationPageHeader, AdministrationState } from "@/components/administration"
import { getSocialAdmission } from "@/data/members"
import { SocialAdmissionForm } from "./social-admission-form"

export const metadata = { title: "Social admission" }

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
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Social admission" />
      <SocialAdmissionForm data={data} orgSlug={orgSlug} />
    </div>
  )
}
