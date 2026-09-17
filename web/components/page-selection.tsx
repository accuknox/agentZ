"use client"

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useRef,
  useTransition,
  type ComponentProps,
  type ReactNode,
} from "react"
import type { Route } from "next"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import { useRouter } from "@bprogress/next/app"
import {
  encodeSelectionHistory,
  readSelectionHistory,
  rememberSelection,
  restoreSelection,
  selectionCookie,
  selectionGroups,
  selectionPages,
  selectionURL,
  type PageSelection,
  type SelectionHistory,
  type SelectionPage,
} from "@/lib/page-selection"

type SelectionContextValue = {
  scope: string
  basePath: string
  history: SelectionHistory
  read: () => SelectionHistory
  remember: (page: SelectionPage, selected: PageSelection, requested: PageSelection) => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

/** Share defaults with navigation links without changing the active page in other tabs. */
export function PageSelectionProvider({
  scope,
  basePath,
  initialHistory,
  children,
}: {
  scope: string
  basePath: string
  initialHistory: SelectionHistory
  children: ReactNode
}) {
  const [history, setHistory] = useState(initialHistory)
  const channel = useRef<BroadcastChannel | null>(null)
  const storageUnavailable = useRef(false)

  function read() {
    if (storageUnavailable.current) return history
    try {
      const value = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith(`${selectionCookie}=`))
        ?.slice(selectionCookie.length + 1)
      return value ? readSelectionHistory(value) : history
    } catch {
      return history
    }
  }

  const refresh = useEffectEvent(() => setHistory(read()))
  useEffect(() => {
    const update = () => refresh()
    try {
      channel.current = new BroadcastChannel(selectionCookie)
      channel.current.addEventListener("message", update)
    } catch {
      // Focus still refreshes link defaults when cross-tab messaging is unavailable.
    }
    window.addEventListener("focus", update)
    update()
    return () => {
      channel.current?.close()
      channel.current = null
      window.removeEventListener("focus", update)
    }
  }, [])

  function remember(page: SelectionPage, selected: PageSelection, requested: PageSelection) {
    const next = rememberSelection(read(), scope, page, selected, requested)
    const value = encodeSelectionHistory(next)
    try {
      document.cookie = `${selectionCookie}=${value}; Path=/; Max-Age=15552000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`
      storageUnavailable.current = !document.cookie
        .split("; ")
        .includes(`${selectionCookie}=${value}`)
      channel.current?.postMessage(null)
    } catch {
      // Keep this tab usable when browser persistence is disabled.
      storageUnavailable.current = true
    }
    setHistory(next)
  }

  return (
    <SelectionContext value={{ scope, basePath, history, read, remember }}>
      {children}
    </SelectionContext>
  )
}

/** Record only committed, validated server selections; prefetch never writes preferences. */
export function RememberPageSelection({
  selected,
  requested,
}: {
  selected: PageSelection
  requested: PageSelection
}) {
  const context = useContext(SelectionContext)
  const pathname = usePathname()
  const selectedKey = JSON.stringify(selected)
  const requestedKey = JSON.stringify(requested)
  const commit = useEffectEvent(() => {
    if (!context || document.visibilityState === "hidden") return
    const page = selectionPages.find((page) => pathname === `${context.basePath}/${page}`)
    if (!page || location.pathname !== pathname) return
    const search = new URLSearchParams(location.search)
    if (
      Object.entries(requested).some(([key, value]) => search.has(key) && search.get(key) !== value)
    )
      return
    context.remember(page, selected, requested)
    const changed = selectionGroups(page, requested)
      .flat()
      .some((key) => requested[key] !== selected[key])
    const href = selectionURL(pathname, search, selected, changed) + location.hash
    if (`${location.pathname}${location.search}${location.hash}` !== href)
      window.history.replaceState(null, "", href)
  })
  useEffect(() => {
    commit()
  }, [pathname, selectedKey, requestedKey])
  return null
}

/** Keep prefetched URLs and the eventual click aligned with the latest defaults. */
export function SelectionLink<T extends string>({
  href,
  onNavigate,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: Route<T> }) {
  const context = useContext(SelectionContext)
  const router = useRouter()
  function destination(history: SelectionHistory | undefined): Route<T> {
    if (!context || !history) return href
    const url = new URL(href, "http://selection.local")
    const page = selectionPages.find((page) => url.pathname === `${context.basePath}/${page}`)
    if (!page) return href
    const requested: PageSelection = {}
    for (const field of selectionGroups(page, {
      type: url.searchParams.get("type") ?? undefined,
    }).flat()) {
      const value = url.searchParams.get(field)
      if (value !== null) requested[field] = value
    }
    const selected = restoreSelection(history, context.scope, page, requested)
    return (selectionURL(url.pathname, url.searchParams, selected, false) + url.hash) as Route<T>
  }
  const target = destination(context?.history)
  return (
    <Link
      {...props}
      href={target}
      onNavigate={(event) => {
        onNavigate?.(event)
        const latest = destination(context?.read())
        if (latest !== target) {
          event.preventDefault()
          router.push(latest)
        }
      }}
    />
  )
}

/** Resource changes are GET navigation; the server validates before rendering any content. */
export function useSelectResource(replace = false) {
  const context = useContext(SelectionContext)
  const pathname = usePathname()
  const search = useSearchParams()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function select(requested: PageSelection) {
    const page =
      context && selectionPages.find((page) => pathname === `${context.basePath}/${page}`)
    const selected =
      context && page ? restoreSelection(context.read(), context.scope, page, requested) : requested
    const href = selectionURL(pathname, search, selected, true)
    startTransition(() => {
      if (replace) router.replace(href)
      else router.push(href)
    })
  }

  return { pending, select }
}
