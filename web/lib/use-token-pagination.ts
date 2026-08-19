"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import type { OnChangeFn, SortingState } from "@tanstack/react-table"
import { usePathname, useSearchParams } from "next/navigation"

type TokenPaginationConfig = {
  pageTokenKey: string
  tokenStackKey: string
}

type ServerSortingConfig<T extends string> = {
  fields: Record<string, T>
  pageTokenKey?: string
  sorting: SortingState
  sortByKey?: string
  sortOrderKey?: string
  tokenStackKey?: string
}

export function useServerSorting<T extends string>({
  fields,
  pageTokenKey,
  sorting,
  sortByKey = "sort_by",
  sortOrderKey = "sort_order",
  tokenStackKey,
}: ServerSortingConfig<T>) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = React.useTransition()

  const onSortingChange: OnChangeFn<SortingState> = (update) => {
    const next = typeof update === "function" ? update(sorting) : update
    const active = next[0]
    const field = active ? fields[active.id] : undefined
    const params = new URLSearchParams(searchParams)
    if (active && field) {
      params.set(sortByKey, field)
      params.set(sortOrderKey, active.desc ? "desc" : "asc")
    } else {
      params.delete(sortByKey)
      params.delete(sortOrderKey)
    }
    if (pageTokenKey) params.delete(pageTokenKey)
    if (tokenStackKey) params.delete(tokenStackKey)

    startTransition(() => {
      const query = params.toString()
      router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false })
    })
  }

  return { onSortingChange }
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
