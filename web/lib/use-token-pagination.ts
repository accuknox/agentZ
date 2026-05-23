"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { usePathname, useSearchParams } from "next/navigation"

type TokenPaginationConfig = {
  pageTokenKey: string
  tokenStackKey: string
}

export function useTokenPagination(config: TokenPaginationConfig) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = React.useTransition()
  const stack = parseTokenStack(searchParams.get(config.tokenStackKey))
  const currentPageToken = searchParams.get(config.pageTokenKey)
  const canGoPrevious = stack.length > 0 || currentPageToken !== null

  function replace(values: { pageToken?: string; tokenStack?: string[] }) {
    const params = new URLSearchParams(searchParams)
    if (values.pageToken) {
      params.set(config.pageTokenKey, values.pageToken)
    } else {
      params.delete(config.pageTokenKey)
    }

    if (values.tokenStack && values.tokenStack.length > 0) {
      params.set(config.tokenStackKey, values.tokenStack.join(","))
    } else {
      params.delete(config.tokenStackKey)
    }

    startTransition(() => {
      const query = params.toString()
      router.replace(query === "" ? pathname : `${pathname}?${query}`)
    })
  }

  return {
    pending,
    canGoPrevious,
    goPrevious() {
      const nextStack = stack.slice(0, -1)
      replace({ pageToken: stack.at(-1), tokenStack: nextStack })
    },
    goNext(nextPageToken: string) {
      replace({
        pageToken: nextPageToken,
        tokenStack: currentPageToken ? [...stack, currentPageToken] : stack,
      })
    },
  }
}

function parseTokenStack(value: string | null) {
  if (!value) {
    return []
  }

  return value.split(",").filter(Boolean)
}
