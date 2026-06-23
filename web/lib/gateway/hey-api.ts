import type { CreateClientConfig } from "@/lib/gateway/client/client"
import { gatewayBaseURL } from "@/lib/gateway/base-url"
import { getGatewayToken } from "@/lib/gateway/token-action"

const baseUrl = gatewayBaseURL()

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  auth: () => getGatewayToken(),
  baseUrl,
})
