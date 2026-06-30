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
  const [staticOpen, setStaticOpen] = React.useState(false)
  const [oauthOpen, setOAuthOpen] = React.useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="w-28 justify-between gap-2 px-3" aria-label="Create secret">
            <span>Create</span>
            <ChevronDown className="text-primary-foreground/80" />
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
