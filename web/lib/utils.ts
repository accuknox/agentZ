import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { QueryClient, defaultShouldDehydrateQuery, environmentManager } from "@tanstack/react-query"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

let browserQueryClient: { identity: string; client: QueryClient } | undefined

export function getQueryClient(identity: string) {
  if (environmentManager.isServer()) {
    // Server: always make a new query client
    return makeQueryClient()
  }
  if (!browserQueryClient || browserQueryClient.identity !== identity) {
    browserQueryClient?.client.clear()
    browserQueryClient = { identity, client: makeQueryClient() }
  }
  return browserQueryClient.client
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
