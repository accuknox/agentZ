import { AdministrationState } from "@/components/administration"
import { AuditDrawer } from "../../audit-drawer"

export default function NotFound() {
  return (
    <AuditDrawer>
      <AdministrationState kind="not-found" title="Audit event not found" />
    </AuditDrawer>
  )
}
