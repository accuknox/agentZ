import { AdministrationPageHeader } from "@/components/administration"
import { Badge } from "@/components/ui/badge"

export default function WorkspacePage() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <AdministrationPageHeader title="Overview" />
      <dl className="max-w-2xl px-4 md:px-6">
        <div className="flex items-center justify-between gap-4 py-2">
          <dt className="font-medium">Workspace status</dt>
          <dd>
            <Badge variant="successPlain">Ready</Badge>
          </dd>
        </div>
      </dl>
    </div>
  )
}
