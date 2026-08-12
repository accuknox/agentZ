"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Boxes, Building2, ChevronsUpDown, Plus } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { SidebarScope } from "./sidebar"

export function WorkspaceSwitcher({ scope }: { scope: SidebarScope }) {
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = useState(false)

  if (scope.kind === "no-access") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="No workspace access"
            size="lg"
            tooltip="No workspace access"
          >
            <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
              <Building2 aria-hidden="true" />
            </span>
            <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium" title={scope.organization.name}>
                {scope.organization.name}
              </span>
              <span className="text-muted-foreground truncate text-xs">No workspace access</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  if (scope.kind === "organization" || scope.kind === "workspace") {
    const active = scope.kind === "workspace" ? scope.workspace : undefined
    const root = `/orgs/${scope.organization.slug}`
    const close = () => {
      setOpen(false)
      if (isMobile) {
        setOpenMobile(false)
      }
    }

    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger asChild>
              <SidebarMenuButton
                aria-label="Choose Workspace"
                size="lg"
                tooltip={active?.name ?? scope.organization.name}
              >
                <span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                  {active ? <Boxes aria-hidden="true" /> : <Building2 aria-hidden="true" />}
                </span>
                <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span
                    className="truncate font-medium"
                    title={active?.name ?? scope.organization.name}
                  >
                    {active?.name ?? scope.organization.name}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {active ? scope.organization.name : "Organisation"}
                  </span>
                </span>
                <ChevronsUpDown aria-hidden="true" className="ml-auto" />
              </SidebarMenuButton>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-88 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
              sideOffset={8}
            >
              <div className="border-b px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                    <Building2 aria-hidden="true" className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium" title={scope.organization.name}>
                      {scope.organization.name}
                    </span>
                    <span className="text-muted-foreground block text-xs">Organisation</span>
                  </span>
                </div>
              </div>
              <Command>
                <CommandInput placeholder="Search Workspaces…" />
                <CommandList className="max-h-72">
                  <CommandEmpty>No matching Workspaces.</CommandEmpty>
                  <CommandGroup heading="Switch Workspace">
                    {scope.workspaces.map((workspace) => (
                      <CommandItem
                        className="h-auto cursor-pointer gap-3 rounded-md px-2 py-2.5"
                        key={workspace.id}
                        data-checked={workspace.id === active?.id}
                        value={`${workspace.name} ${workspace.slug}`}
                        onSelect={() => {
                          close()
                          router.push(`${root}/workspaces/${workspace.slug}` as Route)
                        }}
                      >
                        <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                          <Boxes aria-hidden="true" className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium" title={workspace.name}>
                            {workspace.name}
                          </span>
                          <span className="text-muted-foreground block text-xs capitalize">
                            {workspace.state}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              {scope.canEnterOrganization || scope.canCreateWorkspace ? <Separator /> : null}
              <div className="flex flex-col gap-1 p-1.5">
                {scope.canEnterOrganization ? (
                  <Button asChild className="h-auto justify-start gap-3 px-2 py-2" variant="ghost">
                    <Link href={`${root}/workspaces` as Route} onClick={close}>
                      <span className="bg-muted flex size-8 items-center justify-center rounded-md">
                        <Building2 aria-hidden="true" className="size-4" />
                      </span>
                      <span className="text-left">
                        <span className="block">Manage Workspaces</span>
                        <span className="text-muted-foreground block text-xs font-normal">
                          Organisation administration
                        </span>
                      </span>
                    </Link>
                  </Button>
                ) : null}
                {scope.canCreateWorkspace ? (
                  <Button asChild className="h-auto justify-start gap-3 px-2 py-2" variant="ghost">
                    <Link href={`${root}/workspaces/new` as Route} onClick={close}>
                      <span className="bg-muted flex size-8 items-center justify-center rounded-md">
                        <Plus aria-hidden="true" className="size-4" />
                      </span>
                      Create Workspace
                    </Link>
                  </Button>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
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
