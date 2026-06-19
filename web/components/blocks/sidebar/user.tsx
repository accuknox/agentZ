import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"

export function NavUser({
  user,
}: {
  user: {
    name: string
    image?: string | null
  }
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg">
          <Avatar className="size-8 rounded-lg">
            <AvatarImage src={user.image ?? undefined} alt={user.name} />
            <AvatarFallback className="rounded-lg bg-transparent">
              {user.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part) => part[0]?.toUpperCase() ?? "")
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{user.name}</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
