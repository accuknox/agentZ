"use client"

import { useTokenPagination as useSharedTokenPagination } from "@/lib/use-token-pagination"

export function shortLensID(value: string) {
  return value.slice(0, 8)
}

export function percentOf(value: number, total: number) {
  if (total <= 0) {
    return 0
  }

  return (value / total) * 100
}

export function useTokenPagination() {
  return useSharedTokenPagination({
    pageTokenKey: "page_token",
    tokenStackKey: "token_stack",
  })
}
