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
              className="w-80 max-w-[calc(100vw-2rem)] p-0"
              sideOffset={8}
            >
              <Command>
                <CommandInput placeholder="Search Workspaces…" />
                <CommandList>
                  <CommandEmpty>No matching Workspaces.</CommandEmpty>
                  <CommandGroup heading="Workspaces">
                    {scope.workspaces.map((workspace) => (
                      <CommandItem
                        key={workspace.id}
                        data-checked={workspace.id === active?.id}
                        value={`${workspace.name} ${workspace.slug}`}
                        onSelect={() => {
                          close()
                          router.push(`${root}/workspaces/${workspace.slug}` as Route)
                        }}
                      >
                        <Boxes aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                        <span className="text-muted-foreground text-xs capitalize">
                          {workspace.state}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              {scope.canEnterOrganization || scope.canCreateWorkspace ? <Separator /> : null}
              <div className="flex flex-col gap-1 p-1">
                {scope.canEnterOrganization ? (
                  <Button asChild className="justify-start" variant="ghost">
                    <Link href={`${root}/workspaces` as Route} onClick={close}>
                      <Building2 />
                      Organisation Workspaces
                    </Link>
                  </Button>
                ) : null}
                {scope.canCreateWorkspace ? (
                  <Button asChild className="justify-start" variant="ghost">
                    <Link href={`${root}/workspaces/new` as Route} onClick={close}>
                      <Plus />
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
