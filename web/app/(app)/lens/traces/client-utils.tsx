"use client"

import { useTokenPagination as useSharedTokenPagination } from "@/lib/use-token-pagination"

const numberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatCompactNumber(value: number) {
  return numberFormatter.format(value)
}

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
