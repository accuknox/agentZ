import type { Route } from "next"
import Link from "next/link"
import { Building2 } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import type { SidebarScope } from "./sidebar"

export function WorkspaceSwitcher({ scope }: { scope: SidebarScope }) {
  if (scope.kind === "organization") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild size="lg" tooltip={scope.organization.name}>
            <Link href={`/orgs/${scope.organization.slug}` as Route}>
              <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                <Building2 aria-hidden="true" className="size-4" />
              </span>
              <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium" title={scope.organization.name}>
                  {scope.organization.name}
                </span>
                <span className="text-muted-foreground truncate text-xs">Organisation</span>
              </span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild size="lg" tooltip="AgentZ">
          <Link href="/" className="flex items-center gap-2">
            <Avatar className="size-8">
              <AvatarImage alt="AgentZ" src="/emblem.svg" />
              <AvatarFallback>AZ</AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">AgentZ</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
