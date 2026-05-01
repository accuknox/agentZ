import type { CreateClientConfig } from "@/lib/gateway/client/client"

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: process.env.NEXT_PUBLIC_GATEWAY_BASE_URL,
})
