"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { queryOptions, useQuery } from "@tanstack/react-query"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import { getTenant, type Tenant } from "@/lib/gateway/client"

export function BootstrappingStatus({ initialTenant }: { initialTenant: Tenant }) {
  const router = useRouter()
  const query = useQuery(
    queryOptions({
      initialData: initialTenant,
      queryKey: ["tenant", "status"],
      queryFn: async () => {
        const result = await getTenant({
          baseUrl: await getGatewayBaseURL(),
        })
        if (result.error || !result.data) {
          throw new Error(result.error?.message ?? "Failed to load tenant")
        }

        return result.data
      },
      refetchInterval: (currentQuery) => {
        if (currentQuery.state.data?.ready) {
          return false
        }
        return 2_000
      },
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 0,
    })
  )

  useEffect(() => {
    if (query.data?.ready) {
      router.replace("/")
    }
  }, [query.data?.ready, router])

  return <Shimmer className="text-center">We&apos;re getting everything ready for you.</Shimmer>
}
