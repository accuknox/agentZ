import { AdministrationPageHeader } from "@/components/administration"
import { Badge } from "@/components/ui/badge"

export default function WorkspacePage() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <AdministrationPageHeader title="Overview" />
      <dl className="border-y">
        <div className="flex items-center justify-between gap-4 py-4">
          <dt className="font-medium">Workspace status</dt>
          <dd>
            <Badge variant="successPlain">Ready</Badge>
          </dd>
        </div>
      </dl>
    </div>
  )
}
