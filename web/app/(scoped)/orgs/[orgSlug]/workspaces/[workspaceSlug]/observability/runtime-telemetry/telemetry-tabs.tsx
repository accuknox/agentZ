"use client"

import type { Route } from "next"
import { Cpu, HardDrive, Network } from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

export function TelemetryTabs({ basePath }: { basePath: string }) {
  const searchParams = useSearchParams()

  const href = (tab: "process" | "file" | "network"): Route => {
    const next = new URLSearchParams(searchParams.toString())
    const query = next.toString()
    const path = tab === "process" ? basePath : `${basePath}/${tab}`

    if (!query) {
      return path as Route
    }

    return `${path}?${query}` as Route
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
