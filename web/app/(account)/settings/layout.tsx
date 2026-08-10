import { RouteTabs, type RouteTab } from "@/components/route-tabs"
import type { ReactNode } from "react"

const settingsTabs = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/sessions", label: "Sessions" },
  { href: "/settings/preferences", label: "Preferences" },
] as const satisfies readonly RouteTab[]

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="border-b px-4 pt-3 md:px-6">
        <RouteTabs label="Personal settings" tabs={settingsTabs} />
      </div>
      {children}
    </div>
  )
}
