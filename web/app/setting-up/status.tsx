"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { getTenantOptions } from "@/lib/gateway/client/@tanstack/react-query.gen"
import type { Tenant } from "@/lib/gateway/client/types.gen"

export function BootstrappingStatus({ initialTenant }: { initialTenant: Tenant }) {
  const router = useRouter()
  const query = useQuery({
    ...getTenantOptions(),
    initialData: initialTenant,
    refetchInterval: (currentQuery) => {
      if (currentQuery.state.data?.ready) {
        return false
      }
      return 2_000
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  })

  useEffect(() => {
    if (query.data?.ready) {
      router.replace("/")
    }
  }, [query.data?.ready, router])

  return <Shimmer className="text-center">We&apos;re getting everything ready for you.</Shimmer>
}
