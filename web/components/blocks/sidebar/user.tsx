"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, LogOut, Monitor, Settings, User2 } from "lucide-react"
import { useState } from "react"
import { authClient } from "@/lib/auth-client"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export function NavUser({
  user,
}: {
  user: {
    email?: string | null
    name: string
    image?: string | null
  }
}) {
  const router = useRouter()
  const { isMobile } = useSidebar()
  const [isPending, setIsPending] = useState(false)
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")

  async function handleSignOut() {
    if (isPending) return

    setIsPending(true)
    const { error } = await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login")
          router.refresh()
        },
      },
    })
    if (error) {
      setIsPending(false)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="size-8 rounded-lg">
                <AvatarImage src={user.image ?? undefined} alt={user.name} />
                <AvatarFallback className="rounded-lg bg-transparent">{initials}</AvatarFallback>
              </Avatar>
              <span className="truncate">{user.name}</span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarImage src={user.image ?? undefined} alt={user.name} />
                  <AvatarFallback className="rounded-lg bg-transparent">{initials}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  {user.email ? (
                    <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                  ) : null}
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <User2 />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/sessions">
                  <Monitor />
                  Sessions
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings />
                All settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={isPending}
              aria-busy={isPending}
              onSelect={(event) => {
                event.preventDefault()
                void handleSignOut()
              }}
            >
              {isPending ? <Spinner /> : <LogOut />}
              {isPending ? "Logging out..." : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
