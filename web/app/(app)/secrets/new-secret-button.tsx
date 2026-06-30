"use client"

import * as React from "react"
import { ChevronDown, FileKey2, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { OAuthSecretSheet } from "./oauth-secret-sheet"
import { SecretSheet } from "./secret-sheet"
import type { PutSecretFormAction } from "@/data/types"

export function NewSecretButton({
  agentName,
  putSecretAction,
  startOAuthAction,
}: {
  agentName: string
  putSecretAction: PutSecretFormAction
  startOAuthAction: PutSecretFormAction
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [staticOpen, setStaticOpen] = React.useState(false)
  const [oauthOpen, setOAuthOpen] = React.useState(false)

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant={menuOpen ? "outline-primary" : "default"}
            className="w-28 justify-between px-3"
            aria-label="Create secret"
          >
            <span>Create</span>
            <ChevronDown
              data-icon="inline-end"
              className={cn(
                "transition-transform motion-reduce:transition-none",
                menuOpen && "rotate-180"
              )}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-48 rounded-lg p-1">
          <DropdownMenuItem
            className="gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm"
            onSelect={() => setStaticOpen(true)}
          >
            <KeyRound className="text-muted-foreground size-4" />
            <span>Static</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm"
            onSelect={() => setOAuthOpen(true)}
          >
            <FileKey2 className="text-muted-foreground size-4" />
            <span>OAuth</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {staticOpen ? (
        <SecretSheet
          agentName={agentName}
          putSecretAction={putSecretAction}
          open={staticOpen}
          onOpenChangeAction={setStaticOpen}
        />
      ) : null}
      {oauthOpen ? (
        <OAuthSecretSheet
          agentName={agentName}
          open={oauthOpen}
          onOpenChangeAction={setOAuthOpen}
          startOAuthAction={startOAuthAction}
        />
      ) : null}
    </>
  )
}
