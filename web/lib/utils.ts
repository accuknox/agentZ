import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { QueryClient, defaultShouldDehydrateQuery, environmentManager } from "@tanstack/react-query"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

let browserIdentity: string | undefined
let browserQueryClient: QueryClient | undefined = undefined

export function getQueryClient(identity: string) {
  if (environmentManager.isServer()) {
    // Server: always make a new query client
    return makeQueryClient()
  }
  if (identity !== browserIdentity) {
    browserQueryClient?.clear()
    browserQueryClient = undefined
    browserIdentity = identity
  }
  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
      dehydrate: {
        // include pending queries in dehydration
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
    },
  })
}
