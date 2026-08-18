"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { PanelsTopLeft, ChevronsUpDown, Plus } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage, OrganizationAvatar } from "@/components/ui/avatar"
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
  const [selected, setSelected] = useState("")

  if (scope.kind === "no-access") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="No workspace access"
            size="lg"
            tooltip="No workspace access"
          >
            <OrganizationAvatar
              className="size-8"
              logo={scope.organization.logo}
              name={scope.organization.name}
            />
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
          <Popover
            onOpenChange={(nextOpen) => {
              setOpen(nextOpen)
              if (nextOpen) {
                setSelected(active?.id ?? `organization:${scope.organization.id}`)
              }
            }}
            open={open}
          >
            <PopoverTrigger asChild>
              <SidebarMenuButton
                aria-label="Choose Workspace"
                size="lg"
                tooltip={active?.name ?? scope.organization.name}
              >
                <OrganizationAvatar
                  className="size-8"
                  logo={scope.organization.logo}
                  name={scope.organization.name}
                />
                <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span
                    className="truncate font-medium"
                    title={active?.name ?? scope.organization.name}
                  >
                    {active?.name ?? scope.organization.name}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {active ? "Workspace" : "Organisation"}
                  </span>
                </span>
                <ChevronsUpDown aria-hidden="true" className="ml-auto" />
              </SidebarMenuButton>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl p-0"
              sideOffset={8}
            >
              <Link
                aria-current={scope.kind === "organization" ? "page" : undefined}
                className="hover:bg-muted/60 focus-visible:ring-ring/50 aria-[current=page]:bg-muted/60 mx-1 mt-1 flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 outline-none focus-visible:ring-3"
                href={root as Route}
                onClick={close}
              >
                <OrganizationAvatar
                  className="size-7"
                  logo={scope.organization.logo}
                  name={scope.organization.name}
                />
                <span className="min-w-0">
                  <span
                    className="block truncate text-sm font-medium"
                    title={scope.organization.name}
                  >
                    {scope.organization.name}
                  </span>
                  <span className="text-muted-foreground block text-xs">Organisation</span>
                </span>
              </Link>
              <Command
                className="border-border/60 rounded-none! border-t [&_[data-slot=command-input-wrapper]]:pt-0"
                onValueChange={setSelected}
                value={selected}
              >
                <CommandInput placeholder="Search Workspaces..." />
                <CommandList className="max-h-72">
                  <CommandEmpty>No matching Workspaces.</CommandEmpty>
                  <CommandGroup heading="Workspaces">
                    {scope.workspaces.map((workspace) => (
                      <CommandItem
                        className="data-[checked=true]:bg-muted/70 h-auto cursor-pointer gap-2.5 rounded-lg px-2 py-2"
                        key={workspace.id}
                        data-checked={workspace.id === active?.id}
                        keywords={[workspace.name, workspace.slug]}
                        value={workspace.id}
                        onSelect={() => {
                          close()
                          router.push(`${root}/workspaces/${workspace.slug}` as Route)
                        }}
                      >
                        <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
                          <PanelsTopLeft aria-hidden="true" className="size-3.5" />
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
              {scope.canCreateWorkspace ? (
                <div className="border-border/60 border-t p-1">
                  <Button asChild className="h-9 w-full justify-start gap-2.5 px-2" variant="ghost">
                    <Link href={`${root}/workspaces/new` as Route} onClick={close}>
                      <Plus aria-hidden="true" className="text-muted-foreground size-4" />
                      Create Workspace
                    </Link>
                  </Button>
                </div>
              ) : null}
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
              <AvatarImage alt="AgentZ" className="object-contain" src="/agentz-logo.svg" />
              <AvatarFallback>AZ</AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">AgentZ</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
