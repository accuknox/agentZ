import type { CreateClientConfig } from "@/lib/gateway/client/client"
import { gatewayAuthenticatedFetch } from "@/lib/gateway/browser-runtime"

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  fetch: gatewayAuthenticatedFetch,
})
