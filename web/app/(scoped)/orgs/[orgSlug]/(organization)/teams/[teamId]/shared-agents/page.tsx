import { AdministrationState } from "@/components/administration"

export default function SharedAgentsPage() {
  return (
    <AdministrationState
      description="Agent sharing with Teams will be available in a later release."
      kind="empty"
      title="No shared Agents"
    />
  )
}
