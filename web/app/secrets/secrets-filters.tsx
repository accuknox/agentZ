"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { Agent } from "@/lib/gateway/client"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BotIcon } from "lucide-react"

export function SecretsFilters({
  agents,
  selectedSessionID,
}: {
  agents: Agent[]
  selectedSessionID?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()

  function updateSessionID(sessionID: string) {
    const params = new URLSearchParams(searchParams)
    params.delete("page_token")
    params.delete("token_stack")
    if (sessionID) {
      params.set("session_id", sessionID)
    } else {
      params.delete("session_id")
    }

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`)
    })
  }

  return (
    <div
      data-pending={pending}
      className="flex min-h-14 flex-col gap-3 border-b bg-background px-6 py-2 data-[pending=true]:opacity-70 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select
          value={selectedSessionID}
          onValueChange={updateSessionID}
          disabled={agents.length === 0}
        >
          <SelectTrigger className="h-8 w-full min-w-52 rounded-md sm:w-64">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {agents.map((agent) => (
                <SelectItem key={agent.session_id} value={agent.session_id}>
                  <BotIcon className="inline-block" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
