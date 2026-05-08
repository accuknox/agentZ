"use client"

import { useTokenPagination } from "@/lib/use-token-pagination"

export function useTelemetryPagination() {
  return useTokenPagination({
    pageTokenKey: "telemetry_page_token",
    tokenStackKey: "telemetry_token_stack",
  })
}
