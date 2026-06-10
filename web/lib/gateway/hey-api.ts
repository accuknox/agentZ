import type { CreateClientConfig } from "@/lib/gateway/client/client"
import { gatewayBaseURL } from "@/lib/gateway/base-url"

const baseUrl = gatewayBaseURL()

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl,
})
