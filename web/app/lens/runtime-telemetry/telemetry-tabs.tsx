"use client"

import { Cpu, HardDrive, Network } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

export function TelemetryTabs() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get("session_id")

  const href = (tab: string) => {
    if (!sessionId) return tab
    return `${tab}?session_id=${sessionId}`
  }

  return (
    <TabsList variant="line" className="h-10 gap-4">
      <TabsTrigger value="process" className="gap-2" asChild>
        <Link href={href("process")}>
          <Cpu data-icon="inline-start" />
          Process
        </Link>
      </TabsTrigger>
      <TabsTrigger value="file" className="gap-2" asChild>
        <Link href={href("file")}>
          <HardDrive data-icon="inline-start" />
          File
        </Link>
      </TabsTrigger>
      <TabsTrigger value="network" className="gap-2" asChild>
        <Link href={href("network")}>
          <Network data-icon="inline-start" />
          Network
        </Link>
      </TabsTrigger>
    </TabsList>
  )
}
