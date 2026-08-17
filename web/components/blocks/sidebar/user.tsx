"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Building2,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Monitor,
  SlidersHorizontal,
  User2,
} from "lucide-react"
import { useState, useTransition } from "react"
import { switchOrganizationAction } from "@/app/(scoped)/orgs/actions"
import { authClient } from "@/lib/auth-client"
import type { OrganizationSummary } from "@/data/organizations"
import { Avatar, AvatarFallback, AvatarImage, OrganizationAvatar } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  activeOrganizationId,
  organizations,
  user,
}: {
  activeOrganizationId?: string | null
  organizations: OrganizationSummary[]
  user: {
    email?: string | null
    name: string
    image?: string | null
  }
}) {
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()
  const [isPending, setIsPending] = useState(false)
  const [isSwitching, startSwitch] = useTransition()
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
          router.push("/signin")
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
              aria-label={`Open user menu for ${user.name}`}
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
            aria-label="User menu"
            className="w-72 max-w-[calc(100vw-2rem)] rounded-lg"
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
            {organizations.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  {isSwitching ? <Spinner className="size-3" /> : <Building2 className="size-3" />}
                  Organisations
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={activeOrganizationId ?? ""}
                  onValueChange={(organizationId) => {
                    if (organizationId === activeOrganizationId) {
                      return
                    }

                    if (isMobile) {
                      setOpenMobile(false)
                    }
                    startSwitch(() => switchOrganizationAction(organizationId))
                  }}
                >
                  {organizations.map((organization) => (
                    <DropdownMenuRadioItem
                      aria-label={`${organization.name} (${organization.slug})`}
                      data-organization-id={organization.id}
                      disabled={isSwitching}
                      className="cursor-pointer"
                      key={organization.id}
                      textValue={`${organization.name} ${organization.slug}`}
                      value={organization.id}
                    >
                      <OrganizationAvatar
                        className="size-5"
                        logo={organization.logo}
                        name={organization.name}
                      />
                      <span className="grid min-w-0 flex-1 text-left leading-tight">
                        <span className="truncate font-medium" title={organization.name}>
                          {organization.name}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">
                          {organization.slug}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuGroup
              onClick={() => {
                if (isMobile) {
                  setOpenMobile(false)
                }
              }}
            >
              <DropdownMenuItem asChild>
                <Link href="/settings/account">
                  <User2 />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings/sessions">
                  <Monitor />
                  Sessions
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings/api-keys">
                  <KeyRound />
                  API keys
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={"/settings/preferences" as Route}>
                  <SlidersHorizontal />
                  Preferences
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
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
