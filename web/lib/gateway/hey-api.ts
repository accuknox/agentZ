import type { CreateClientConfig } from "@/lib/gateway/client/client"
import { getGatewayToken } from "@/lib/gateway/browser-runtime"

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  auth: () => getGatewayToken(),
})
